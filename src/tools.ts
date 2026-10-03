import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LIMITS, batchReportSchema, batchSchema, renderBatchMarkdown, type BatchStatus, type Session } from '@pickfix/protocol';
import type { BatchRecord, QueueStore } from './queue-store.js';
import { normalizeSourcePath } from './source-paths.js';

export const MAX_IMAGES_PER_CLAIM = 8;

export type ToolDeps = {
  store: QueueStore;
  session: Session;
  repoRoot: string;
  linkStatus: () => { port: number | null; reason?: string };
  tokenExists: () => boolean;
  createPairingCode: () => { code: string; expiresAt: number };
  onStatusChanged: (batchId: string) => void;
};

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const error = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function claimMarkdown(deps: ToolDeps, record: BatchRecord): ToolResult {
  const images: Content[] = [];
  const labels = new Map<string, string>();
  for (const item of record.batch.items) {
    const path = deps.store.screenshotPath(record.batch.id, item);
    if (!item.screenshot || !path) continue;
    if (images.length < MAX_IMAGES_PER_CLAIM) {
      images.push({ type: 'image', data: deps.store.screenshotBase64(record.batch.id, item)!, mimeType: item.screenshot.mime });
      labels.set(item.id, `attached as image ${images.length} (also at ${path})`);
    } else {
      labels.set(item.id, `not attached (too many images); read it from ${path}`);
    }
  }
  const markdown = renderBatchMarkdown(record.batch, {
    repoRoot: deps.repoRoot,
    resolveSource: (hint) => (hint.file ? normalizeSourcePath(hint.file, deps.repoRoot) : undefined),
    screenshotLabel: (item) => labels.get(item.id),
  });
  return { content: [{ type: 'text', text: markdown }, ...images] };
}

export function registerTools(server: McpServer, getDeps: () => Promise<ToolDeps>): void {
  server.registerTool(
    'pickfix_status',
    {
      title: 'PickFix status',
      description: 'Show this session\'s PickFix link: repository, WebSocket port (or why there is none), whether the extension can pair, and how many feedback batches are in each state.',
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
          `PickFix session for ${deps.session.name} (${deps.repoRoot})`,
          `Agent: ${deps.session.agent} · session ${deps.session.sessionId}`,
          link.port ? `Extension link: listening on ws://127.0.0.1:${link.port}/pickfix` : `Extension link: not available. ${link.reason ?? ''}`.trim(),
          `Pairing token: ${deps.tokenExists() ? 'present' : 'missing'}`,
          `Batches: ${countText}`,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'pickfix_list_batches',
    {
      title: 'List PickFix batches',
      description: 'List the feedback batches the PickFix extension sent for this repository. By default shows queued and working batches.',
      inputSchema: {
        status: z.enum(['queued', 'working', 'done', 'partial', 'failed', 'cancelled']).optional().describe('Only list batches in this state.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      const deps = await getDeps();
      const statuses: BatchStatus[] = status ? [status] : ['queued', 'working'];
      const batches = deps.store.list(statuses);
      if (batches.length === 0) return ok(`No PickFix batches with status ${statuses.join(' or ')} in this repository.`);
      return ok(
        batches
          .map((b) => `- ${b.id} · ${b.status} · ${plural(b.items, 'item')} · ${b.path} on ${b.origin} · received ${b.receivedAt}`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'pickfix_claim_batch',
    {
      title: 'Claim a PickFix batch',
      description:
        'Claim a feedback batch before changing any code for it, and receive its items: the reviewer\'s requests, where each element lives in the code, and screenshots. Without batchId, claims the oldest queued batch. A batch can be claimed only once across all sessions.',
      inputSchema: { batchId: z.string().optional().describe('The batch id from the channel event or pickfix_list_batches.') },
    },
    async ({ batchId }) => {
      const deps = await getDeps();
      const result = deps.store.claim(deps.session.sessionId, deps.session.pid, batchId);
      if (!result.ok) {
        const id = batchId ?? '';
        const reasons = {
          'none-queued': 'No queued PickFix batches in this repository.',
          'not-found': `No batch "${id}" in this repository. Call pickfix_list_batches to see the available ids.`,
          'already-claimed': `Batch ${id} is already claimed by another session. Do not work on it.`,
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
      title: 'Report a PickFix batch',
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
      title: 'Import a PickFix export',
      description: 'Add a batch exported from the PickFix extension as a JSON file to this repository\'s queue, then claim it with pickfix_claim_batch.',
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
      if (!parsed.success) return error(`${file} is not a PickFix batch export. ${z.prettifyError(parsed.error).slice(0, 800)}`);
      const { record, created } = deps.store.add(parsed.data, deps.session.sessionId);
      if (!created) return ok(`Batch ${record.batch.id} is already in the queue (status: ${record.state.status}).`);
      return ok(`Imported batch ${record.batch.id} with ${plural(record.batch.items.length, 'item')}. Claim it with pickfix_claim_batch.`);
    },
  );

  server.registerTool(
    'pickfix_pair_code',
    {
      title: 'Create a PickFix pairing code',
      description: 'Create a 6-digit code, valid for 2 minutes, that the user enters in the PickFix extension panel to pair it with this machine. Never reveals the token.',
    },
    async () => {
      const deps = await getDeps();
      const link = deps.linkStatus();
      if (!link.port) return error(`The extension link is not available, so pairing cannot work. ${link.reason ?? ''}`.trim());
      const { code } = deps.createPairingCode();
      return ok(`Pairing code: ${code.slice(0, 3)} ${code.slice(3)} (valid for 2 minutes). Ask the user to open the PickFix panel in Chrome and enter this code.`);
    },
  );
}
