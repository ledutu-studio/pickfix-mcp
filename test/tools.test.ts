import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@pickfix/protocol';
import { QueueStore } from '../src/queue-store.js';
import type { ToolDeps } from '../src/tools.js';
import { makeBatch, makeElementItem, PNG_1PX } from '../packages/protocol/test/fixtures.js';
import { tempDir, tempHome } from './helpers.js';
import { startMcp, text } from './mcp-harness.js';

let deps: ToolDeps;
let home: string;
let changed: string[];
let mcp: Awaited<ReturnType<typeof startMcp>>;

function makeDeps(sessionId: string, home: string, repoRoot: string): ToolDeps {
  const session: Session = { sessionId, name: 'shop', cwd: repoRoot, startedAt: '2026-10-02T10:00:00Z', agent: 'claude-code', pid: process.pid };
  return {
    store: new QueueStore({ home, repoRoot, log: () => {} }),
    session,
    repoRoot,
    linkStatus: () => ({ port: 47400 }),
    tokenExists: () => true,
    createPairingCode: () => ({ code: '481273', expiresAt: Date.now() + 120_000 }),
    onStatusChanged: (id) => changed.push(id),
  };
}

beforeEach(async () => {
  const repoRoot = realpathSync(tempDir());
  mkdirSync(join(repoRoot, 'src/components'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/components/CheckoutSummary.tsx'), '');
  changed = [];
  home = tempHome();
  deps = makeDeps('session-a', home, repoRoot);
  mcp = await startMcp(deps);
});

afterEach(async () => {
  await mcp.close();
});

const call = (name: string, args: Record<string, unknown> = {}) => mcp.client.callTool({ name, arguments: args });

it('lists the six tools', async () => {
  const { tools } = await mcp.client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    ['pickfix_claim_batch', 'pickfix_import', 'pickfix_list_batches', 'pickfix_pair_code', 'pickfix_report', 'pickfix_status'].sort(),
  );
});

it('describes the session and the queue', async () => {
  deps.store.add(makeBatch(), 's');
  const out = text(await call('pickfix_status'));
  expect(out).toContain('ws://127.0.0.1:47400/pickfix');
  expect(out).toContain('1 queued');
});

it('says why the extension link is down', async () => {
  deps.linkStatus = () => ({ port: null, reason: 'All ports 47400–47409 are in use by other sessions.' });
  expect(text(await call('pickfix_status'))).toContain('All ports 47400–47409 are in use');
});

describe('pickfix_list_batches', () => {
  it('lists queued and working batches by default', async () => {
    deps.store.add(makeBatch(), 's');
    expect(text(await call('pickfix_list_batches'))).toContain('batch-1 · queued · 1 item · /checkout on localhost:5173');
  });

  it('prints the page path sanitised on one line', async () => {
    const item = makeElementItem();
    deps.store.add(makeBatch({ page: { url: 'http://localhost:5173/x', path: '/a\n<b>bold', title: 'T' }, items: [item] }), 's');
    const out = text(await call('pickfix_list_batches'));
    expect(out.split('\n')).toHaveLength(1);
    expect(out).not.toContain('<');
  });

  it('says when there is nothing', async () => {
    expect(text(await call('pickfix_list_batches'))).toContain('No PickFix batches');
  });
});

describe('pickfix_claim_batch', () => {
  it('returns the markdown with the repo-relative source and the screenshot as an image', async () => {
    deps.store.add(makeBatch({ items: [{ ...makeElementItem(), anchor: { ...makeElementItem().anchor!, source: { ...makeElementItem().anchor!.source, file: join(deps.repoRoot, 'src/components/CheckoutSummary.tsx') } } }] }), 's');
    const result = (await call('pickfix_claim_batch')) as { content: { type: string; data?: string; mimeType?: string }[] };
    const md = text(result);
    expect(md).toContain('# PickFix batch batch-1');
    expect(md).toContain('`src/components/CheckoutSummary.tsx:88:7`');
    expect(md).toContain('**Screenshot:** attached as image 1');
    expect(result.content.find((c) => c.type === 'image')).toMatchObject({ data: PNG_1PX, mimeType: 'image/png' });
    expect(deps.store.readState('batch-1')?.status).toBe('working');
    expect(changed).toEqual(['batch-1']);
  });

  it('lets the owning session claim its working batch again', async () => {
    deps.store.add(makeBatch(), 's');
    await call('pickfix_claim_batch', { batchId: 'batch-1' });
    const again = (await call('pickfix_claim_batch', { batchId: 'batch-1' })) as { isError?: boolean };
    expect(again.isError).toBeFalsy();
    expect(text(again)).toContain('# PickFix batch batch-1');
  });

  it('is an error when nothing is queued', async () => {
    const result = (await call('pickfix_claim_batch')) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No queued PickFix batches');
  });

  it('tells the second session that another session has the batch', async () => {
    deps.store.add(makeBatch(), 's');
    const other = await startMcp(makeDeps('session-b', home, deps.repoRoot));
    try {
      await call('pickfix_claim_batch', { batchId: 'batch-1' });
      const second = (await other.client.callTool({ name: 'pickfix_claim_batch', arguments: { batchId: 'batch-1' } })) as { isError?: boolean };
      expect(second.isError).toBe(true);
      expect(text(second)).toContain('is being handled by another session (session-a). Do not work on it.');
    } finally {
      await other.close();
    }
  });
});

describe('pickfix_claim_batch size budget', () => {
  const bigBatch = () =>
    makeBatch({
      items: Array.from({ length: 50 }, (_, i) => {
        const item = makeElementItem(`item-${i + 1}`);
        return { ...item, comment: `Request ${i + 1}: ${'x'.repeat(300)}`, anchor: { ...item.anchor!, html: `<div>${'y'.repeat(1900)}</div>` } };
      }),
    });

  it('returns a compact summary and writes the full batch to batch.md', async () => {
    deps.store.add(bigBatch(), 's');
    const result = (await call('pickfix_claim_batch')) as { content: { type: string }[] };
    const out = text(result);
    const path = /at (\S+batch\.md)\./.exec(out)?.[1];
    expect(path).toBeDefined();
    expect(out.length).toBeLessThan(60_000);
    expect(out).toContain('- Item 1 · element · item-1: Request 1: ');
    expect(out).toContain('Read it before editing.');
    expect(existsSync(path!)).toBe(true);
    const full = readFileSync(path!, 'utf8');
    expect(full.length).toBeGreaterThan(60_000);
    expect(full).toContain('## Item 50 of 50');
    expect(result.content.filter((c) => c.type === 'image').length).toBeLessThanOrEqual(8);
  });

  it('leaves a small batch unchanged', async () => {
    deps.store.add(makeBatch(), 's');
    const out = text(await call('pickfix_claim_batch'));
    expect(out).toContain('## Item 1 of 1');
    expect(out).not.toContain('batch.md');
  });
});

describe('pickfix_report', () => {
  it('finishes a claimed batch', async () => {
    deps.store.add(makeBatch(), 's');
    await call('pickfix_claim_batch');
    const out = text(await call('pickfix_report', { batchId: 'batch-1', outcome: 'partial', summary: 'Made the button full-width; the colour token is missing.', changedFiles: ['src/a.tsx'], items: [{ itemId: 'item-1', outcome: 'done' }] }));
    expect(out).toContain('Reported batch batch-1 as partial');
    expect(deps.store.readState('batch-1')).toMatchObject({ status: 'partial', report: { changedFiles: ['src/a.tsx'] } });
    expect(changed).toEqual(['batch-1', 'batch-1']);
  });

  it('refuses a summary over 600 characters with a clear message', async () => {
    deps.store.add(makeBatch(), 's');
    await call('pickfix_claim_batch');
    const result = (await call('pickfix_report', { batchId: 'batch-1', outcome: 'done', summary: 'x'.repeat(601) })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('600');
  });

  it('refuses a report for an unclaimed batch', async () => {
    deps.store.add(makeBatch(), 's');
    const result = (await call('pickfix_report', { batchId: 'batch-1', outcome: 'done', summary: 'Done.' })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not been claimed');
  });
});

describe('pickfix_import', () => {
  it('queues an exported batch file', async () => {
    const file = join(deps.repoRoot, 'pickfix-export.json');
    writeFileSync(file, JSON.stringify(makeBatch({ id: 'imported' })));
    expect(text(await call('pickfix_import', { path: 'pickfix-export.json' }))).toContain('Imported batch imported with 1 item');
    expect(deps.store.readState('imported')?.status).toBe('queued');
  });

  it('explains an invalid file', async () => {
    const file = join(deps.repoRoot, 'bad.json');
    writeFileSync(file, '{"schema":"other"}');
    const result = (await call('pickfix_import', { path: file })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not a PickFix batch');
  });
});

describe('pickfix_pair_code', () => {
  it('returns a readable code', async () => {
    expect(text(await call('pickfix_pair_code'))).toContain('481 273');
  });

  it('is an error when the extension link is down', async () => {
    deps.linkStatus = () => ({ port: null, reason: 'All ports are in use.' });
    const result = (await call('pickfix_pair_code')) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

it('serves the fix prompt with the batch id filled in', async () => {
  const prompt = await mcp.client.getPrompt({ name: 'fix', arguments: { batchId: 'batch-9' } });
  const body = (prompt.messages[0]?.content as { text: string }).text;
  expect(body).toContain('pickfix_claim_batch');
  expect(body).toContain('"batch-9" names a batch id');
});

it('returns an error naming the cause when start-up failed', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { registerTools } = await import('../src/tools.js');
  const server = new McpServer({ name: 'pickfix', version: '0.1.0' });
  registerTools(server, () => Promise.reject(new Error('PickFix could not start: boom')));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'pickfix_status', arguments: {} });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('could not start: boom');
  await client.close();
  await server.close();
});
