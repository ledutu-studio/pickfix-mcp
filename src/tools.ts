import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LIMITS, batchReportSchema, batchSchema, renderBatchMarkdown, type BatchStatus, type Session } from '@pickfix/protocol';
import type { BatchRecord, QueueStore } from './queue-store.js';
import { safePath } from './channel.js';
import { normalizeSourcePath } from './source-paths.js';

export const MAX_IMAGES_PER_CLAIM = 8;

export type ToolDeps = {
  store: QueueStore;
  session: Session;
  repoRoot: string;
  linkStatus: () => { port: number | null; reason?: string };
  onStatusChanged: (batchId: string) => void;
};

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const error = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const MAX_INLINE_CHARS = 60_000;
const MAX_CLAIM_CHARS = 80_000;
const IMAGE_COST_CHARS = 1_600 * 4;

function compactLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, max);
}

function claimMarkdown(deps: ToolDeps, record: BatchRecord): ToolResult {
  const { batch } = record;
  const resolveSource = (hint: { file?: string }) => (hint.file ? normalizeSourcePath(hint.file, deps.repoRoot) : undefined);
  const render = (labels: Map<string, string>) =>
    renderBatchMarkdown(batch, { repoRoot: deps.repoRoot, resolveSource, screenshotLabel: (item) => labels.get(item.id) });

  const full = render(new Map());
  const oversized = full.length > MAX_INLINE_CHARS;

  // Claude Code truncates tool output near 25,000 tokens: an oversized batch returns a compact index and a file.
  let compact = '';
  if (oversized) {
    const header = full.split('\n\n')[0];
    const lines = batch.items.map((item, i) => {
      const source = item.anchor?.source.file ? resolveSource(item.anchor.source) : undefined;
      const line = source && item.anchor?.source.line !== undefined ? `:${item.anchor.source.line}` : '';
      const where = source ? ` — ${compactLine(source.path, 200)}${line}` : '';
      return `- Item ${i + 1} · ${item.kind} · ${item.id}: ${compactLine(item.comment, 200)}${where}`;
    });
    compact = `${header}\n\n${lines.join('\n')}`;
  }
  const textLength = oversized ? compact.length + 400 : full.length;

  const images: Content[] = [];
  const labels = new Map<string, string>();
  for (const item of batch.items) {
    const path = deps.store.screenshotPath(batch.id, item);
    if (!item.screenshot || !path) continue;
    const withinBudget = textLength + (images.length + 1) * IMAGE_COST_CHARS <= MAX_CLAIM_CHARS;
    if (images.length < MAX_IMAGES_PER_CLAIM && withinBudget) {
      images.push({ type: 'image', data: deps.store.screenshotBase64(batch.id, item)!, mimeType: item.screenshot.mime });
      labels.set(item.id, `attached as image ${images.length} (also at ${path})`);
    } else {
      labels.set(item.id, `not attached (too many images); read it from ${path}`);
    }
  }

  const markdown = render(labels);
  if (!oversized) return { content: [{ type: 'text', text: markdown }, ...images] };
  const filePath = deps.store.writeBatchMarkdown(batch.id, markdown);
  const text = `${compact}\n\nThe full batch with all page data is at ${filePath}. Read it before editing.`;
  return { content: [{ type: 'text', text }, ...images] };
}

export function registerTools(server: McpServer, getDeps: () => Promise<ToolDeps>): void {
  server.registerTool(
    'pickfix_status',
    {
      title: 'Pickfix status',
      description: 'Show this session\'s Pickfix link: repository, WebSocket port (or why there is none), and how many feedback batches are in each state.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const deps = await getDeps();
      const link = deps.linkStatus();
      const counts = new Map<BatchStatus, number>();
      for (const summary of deps.store.list()) counts.set(summary.status, (counts.get(summary.status) ?? 0) + 1);
      const countText = counts.size === 0 ? 'none' : [...counts].map(([status, n]) => `${n} ${status}`).join(', ');
      return ok(
        [
          `Pickfix session for ${deps.session.name} (${deps.repoRoot})`,
          `Agent: ${deps.session.agent} · session ${deps.session.sessionId}`,
          link.port ? `Extension link: listening on ws://127.0.0.1:${link.port}/pickfix` : `Extension link: not available. ${link.reason ?? ''}`.trim(),
          `Batches: ${countText}`,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'pickfix_list_batches',
    {
      title: 'List Pickfix batches',
      description: 'List the feedback batches the Pickfix extension sent for this repository. By default shows queued and working batches.',
      inputSchema: {
        status: z.enum(['queued', 'working', 'done', 'partial', 'failed', 'cancelled']).optional().describe('Only list batches in this state.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      const deps = await getDeps();
      const statuses: BatchStatus[] = status ? [status] : ['queued', 'working'];
      const batches = deps.store.list(statuses);
      if (batches.length === 0) return ok(`No Pickfix batches with status ${statuses.join(' or ')} in this repository.`);
      return ok(
        batches
          .map((b) => `- ${b.id} · ${b.status} · ${plural(b.items, 'item')} · ${safePath(b.path)} on ${b.origin} · received ${b.receivedAt}`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'pickfix_claim_batch',
    {
      title: 'Claim a Pickfix batch',
      description:
        'Claim a feedback batch before changing any code for it, and receive its items: the reviewer\'s requests, where each element lives in the code, and screenshots. Without batchId, claims the oldest queued batch. A batch can be claimed only once across all sessions.',
      inputSchema: { batchId: z.string().optional().describe('The batch id from the channel event or pickfix_list_batches.') },
    },
    async ({ batchId }) => {
      const deps = await getDeps();
      const result = deps.store.claim(deps.session.sessionId, deps.session.pid, batchId);
      if (!result.ok) {
        const id = batchId ?? '';
        const holder = batchId ? deps.store.owner(batchId)?.sessionId : undefined;
        const reasons = {
          'none-queued': 'No queued Pickfix batches in this repository.',
          'not-found': `No batch "${id}" in this repository. Call pickfix_list_batches to see the available ids.`,
          'already-claimed': `Batch ${id} is being handled by another session${holder ? ` (${holder})` : ''}. Do not work on it.`,
          cancelled: `Batch ${id} was cancelled by the reviewer. Do not work on it.`,
          finished: `Batch ${id} is already finished.`,
        } as const;
        return error(reasons[result.reason]);
      }
      deps.onStatusChanged(result.record.batch.id);
      return claimMarkdown(deps, result.record);
    },
  );

  server.registerTool(
    'pickfix_report',
    {
      title: 'Report a Pickfix batch',
      description:
        'Report the outcome of a batch you claimed. Always call this when you finish, including when you could only partly fix it or not at all; the reviewer sees the summary in the extension.',
      inputSchema: {
        batchId: z.string().describe('The claimed batch.'),
        outcome: z.enum(['done', 'partial', 'failed']).describe('done: every item handled; partial: some items; failed: none.'),
        summary: z.string().describe(`One or two sentences for the reviewer: what changed and where, or why not. At most ${LIMITS.summary} characters.`),
        changedFiles: z.array(z.string()).optional().describe('Repository-relative paths of the files you changed.'),
        items: z
          .array(z.object({ itemId: z.string(), outcome: z.enum(['done', 'skipped', 'failed']), note: z.string().optional() }))
          .optional()
          .describe(`Per-item outcome with a short note (at most ${LIMITS.itemNote} characters each).`),
      },
    },
    async ({ batchId, ...input }) => {
      const deps = await getDeps();
      const parsed = batchReportSchema.safeParse({ ...input, changedFiles: input.changedFiles ?? [], items: input.items ?? [] });
      if (!parsed.success) {
        return error(`The report is invalid: the summary must be 1–${LIMITS.summary} characters and each note at most ${LIMITS.itemNote}. ${z.prettifyError(parsed.error)}`);
      }
      const result = deps.store.report(deps.session.sessionId, batchId, parsed.data);
      if (!result.ok) {
        const reasons = {
          'not-found': `No batch "${batchId}" in this repository.`,
          'not-claimed': `Batch ${batchId} has not been claimed. Call pickfix_claim_batch first.`,
          'claimed-by-other': `Batch ${batchId} was claimed by another session; only that session can report it.`,
          'already-reported': `Batch ${batchId} has already been reported.`,
        } as const;
        return error(reasons[result.reason]);
      }
      deps.onStatusChanged(batchId);
      return ok(`Reported batch ${batchId} as ${parsed.data.outcome}. The reviewer now sees your summary in the extension.`);
    },
  );

  server.registerTool(
    'pickfix_import',
    {
      title: 'Import a Pickfix export',
      description: 'Add a batch exported from the Pickfix extension as a JSON file to this repository\'s queue, then claim it with pickfix_claim_batch.',
      inputSchema: { path: z.string().describe('Path to the exported .json file, absolute or relative to the repository root.') },
    },
    async ({ path }) => {
      const deps = await getDeps();
      const file = isAbsolute(path) ? path : resolve(deps.repoRoot, path);
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        return error(`Could not read ${file}: ${(e as Error).message}`);
      }
      const parsed = batchSchema.safeParse(data);
      if (!parsed.success) return error(`${file} is not a Pickfix batch export. ${z.prettifyError(parsed.error).slice(0, 800)}`);
      const { record, created } = deps.store.add(parsed.data, deps.session.sessionId);
      if (!created) return ok(`Batch ${record.batch.id} is already in the queue (status: ${record.state.status}).`);
      return ok(`Imported batch ${record.batch.id} with ${plural(record.batch.items.length, 'item')}. Claim it with pickfix_claim_batch.`);
    },
  );
}
