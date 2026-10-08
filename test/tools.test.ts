import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@pickfix/protocol';
import { QueueStore } from '../src/queue-store.js';
import type { ToolDeps } from '../src/tools.js';
import { makeAttachment, makeBatch, makeElementItem, makeRegionItem, PNG_1PX } from '../packages/protocol/test/fixtures.js';
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
    ['pickfix_claim_batch', 'pickfix_import', 'pickfix_list_batches', 'pickfix_report', 'pickfix_status'].sort(),
  );
});

it('describes the session and the queue', async () => {
  deps.store.add(makeBatch(), 's');
  const out = text(await call('pickfix_status'));
  expect(out).toContain('ws://127.0.0.1:47400/pickfix');
  expect(out).toContain('1 queued');
  expect(out).toContain('choose Connect manually in the Pickfix panel and enter port 47400');
});

it('says why the extension link is down', async () => {
  deps.linkStatus = () => ({ port: null, reason: 'All ports 47400–47409 are in use by other sessions.' });
  const out = text(await call('pickfix_status'));
  expect(out).toContain('All ports 47400–47409 are in use');
  expect(out).not.toContain('Connect manually');
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
    expect(text(await call('pickfix_list_batches'))).toContain('No Pickfix batches');
  });
});

describe('pickfix_claim_batch', () => {
  it('returns the markdown with the repo-relative source and the screenshot as an image', async () => {
    deps.store.add(makeBatch({ items: [{ ...makeElementItem(), anchor: { ...makeElementItem().anchor!, source: { ...makeElementItem().anchor!.source, file: join(deps.repoRoot, 'src/components/CheckoutSummary.tsx') } } }] }), 's');
    const result = (await call('pickfix_claim_batch')) as { content: { type: string; data?: string; mimeType?: string }[] };
    const md = text(result);
    expect(md).toContain('# Pickfix batch batch-1');
    expect(md).toContain('`src/components/CheckoutSummary.tsx:88:7`');
    expect(md).toContain('**Screenshot (current state):** attached as image 1 (also at');
    expect(result.content.find((c) => c.type === 'image')).toMatchObject({ data: PNG_1PX, mimeType: 'image/png' });
    expect(deps.store.readState('batch-1')?.status).toBe('working');
    expect(changed).toEqual(['batch-1']);
  });

  it('lets the owning session claim its working batch again', async () => {
    deps.store.add(makeBatch(), 's');
    await call('pickfix_claim_batch', { batchId: 'batch-1' });
    const again = (await call('pickfix_claim_batch', { batchId: 'batch-1' })) as { isError?: boolean };
    expect(again.isError).toBeFalsy();
    expect(text(again)).toContain('# Pickfix batch batch-1');
  });

  it('is an error when nothing is queued', async () => {
    const result = (await call('pickfix_claim_batch')) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No queued Pickfix batches');
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

  it('attaches the screenshot, then the reference images, each labelled', async () => {
    const item = { ...makeRegionItem('item-1'), attachments: [makeAttachment('a.png'), makeAttachment('b.png')] };
    deps.store.add(makeBatch({ items: [item] }), 's');
    const result = (await call('pickfix_claim_batch')) as { content: { type: string }[] };
    const md = text(result);
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(md).toMatch(/\*\*Screenshot \(current state\):\*\* attached as image 1 \(also at \S+item-1\.png\)/);
    expect(md).toMatch(/1\. attached as image 2 \(also at \S+item-1.ref-1\.png\)\n2\. attached as image 3 \(also at \S+item-1.ref-2\.png\)/);
  });

  it('attaches at most eight images in item order and points to the rest on disk', async () => {
    const items = [1, 2, 3].map((n) => ({
      ...makeElementItem(`item-${n}`),
      attachments: [makeAttachment('a.png'), makeAttachment('b.png'), makeAttachment('c.png')],
    }));
    deps.store.add(makeBatch({ items }), 's');
    const result = (await call('pickfix_claim_batch')) as { content: { type: string }[] };
    const md = text(result);
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(8);
    expect(md).toMatch(/3\. attached as image 8 \(also at \S+item-2.ref-3\.png\)/);
    expect(md).toMatch(/\*\*Screenshot \(current state\):\*\* not attached \(too many images\); read it from \S+item-3\.png/);
    expect(md).toMatch(/1\. not attached \(too many images\); read it from \S+item-3.ref-1\.png/);
  });

  it('skips a reference image whose file is gone without failing the claim', async () => {
    const { record } = deps.store.add(makeBatch({ items: [{ ...makeElementItem(), attachments: [makeAttachment()] }] }), 's');
    rmSync(deps.store.attachmentPath('batch-1', record.batch.items[0]!.attachments![0]!)!);
    const result = (await call('pickfix_claim_batch')) as { content: { type: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(text(result)).toContain('1. missing from the queue folder');
    expect(text(result)).not.toContain('included in the batch file');
  });

  it('labels a screenshot whose file is gone as missing from the queue folder', async () => {
    const { record } = deps.store.add(makeBatch({ items: [makeElementItem()] }), 's');
    rmSync(deps.store.screenshotPath('batch-1', record.batch.items[0]!)!);
    const result = (await call('pickfix_claim_batch')) as { content: { type: string }[] };
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(text(result)).toContain('**Screenshot (current state):** missing from the queue folder');
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

  it('names region and image-only items in the compact index, even a region with no elements', async () => {
    const batch = bigBatch();
    const region = makeRegionItem('item-1');
    batch.items[0] = { ...region, comment: '', attachments: [makeAttachment()], region: { ...region.region!, anchors: [] } };
    deps.store.add(batch, 's');
    const out = text(await call('pickfix_claim_batch'));
    expect(out).toContain('- Item 1 · region · item-1: (reference images only)');
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

  it('tells the user to export again when the file comes from an older Pickfix', async () => {
    const file = join(deps.repoRoot, 'old.json');
    writeFileSync(file, JSON.stringify({ ...makeBatch({ id: 'old' }), schema: 'pickfix.batch/1' }));
    const result = (await call('pickfix_import', { path: file })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('This file was exported by an older Pickfix. Export it again with the current extension.');
    expect(deps.store.readState('old')).toBeUndefined();
  });

  it('tells the user to update pickfix-mcp when the file comes from a newer Pickfix', async () => {
    const file = join(deps.repoRoot, 'new.json');
    writeFileSync(file, JSON.stringify({ ...makeBatch({ id: 'new' }), schema: 'pickfix.batch/99' }));
    const result = (await call('pickfix_import', { path: file })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('This file was exported by a newer Pickfix. Update pickfix-mcp.');
    expect(deps.store.readState('new')).toBeUndefined();
  });

  it('explains an invalid file', async () => {
    const file = join(deps.repoRoot, 'bad.json');
    writeFileSync(file, '{"schema":"other"}');
    const result = (await call('pickfix_import', { path: file })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not a Pickfix batch');
  });
});

it('serves the fix prompt with the batch id filled in', async () => {
  const prompt = await mcp.client.getPrompt({ name: 'fix', arguments: { batchId: 'batch-9' } });
  const body = (prompt.messages[0]?.content as { text: string }).text;
  expect(body).toContain('pickfix_claim_batch');
  expect(body).toContain('"batch-9" names a batch id');
  expect(body).toContain('reference images show the look the reviewer wants');
  expect(body).toContain('For `region` items');
  expect(body).toContain('An item with no written request means: make the target match its reference image(s).');
});

it('returns an error naming the cause when start-up failed', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { registerTools } = await import('../src/tools.js');
  const server = new McpServer({ name: 'pickfix', version: '0.1.0' });
  registerTools(server, () => Promise.reject(new Error('Pickfix could not start: boom')));
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
