import { realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAttachment, makeBatch, makeRegionItem } from '../../packages/protocol/test/fixtures.js';
import { tempDir, tempHome } from '../helpers.js';
import { connect as rawConnect, rejectedStatus, type TestClient } from '../ws-client.js';

const SERVER = resolve('plugin/dist/server.mjs');
const DEV_ID = 'e2etestextensionid';
const ORIGIN = `chrome-extension://${DEV_ID}`;

type Agent = { pid: number | null; client: Client; notifications: { method: string; params?: Record<string, unknown> }[]; port: number; close(): Promise<void> };
const running: Agent[] = [];
const sockets: TestClient[] = [];

async function connect(port: number, options: Parameters<typeof rawConnect>[1] = {}) {
  const socket = await rawConnect(port, options);
  sockets.push(socket);
  return socket;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.ws.terminate();
  for (const agent of running.splice(0)) await agent.close().catch(() => {});
});

const textOf = (result: unknown) =>
  (result as { content: { type: string; text?: string }[] }).content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function startAgent(home: string, repo: string): Promise<Agent> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: repo,
    env: { ...(process.env as Record<string, string>), PICKFIX_HOME: home, PICKFIX_EXTENSION_IDS: DEV_ID },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  const notifications: Agent['notifications'] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n as Agent['notifications'][number]);
  };
  const agent: Agent = { pid: null, client, notifications, port: 0, close: () => client.close() };
  running.push(agent);
  await client.connect(transport);
  agent.pid = transport.pid;
  const status = textOf(await client.callTool({ name: 'pickfix_status', arguments: {} }));
  const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)\/pickfix/.exec(status)?.[1]);
  expect(port).toBeGreaterThan(0);
  agent.port = port;
  return agent;
}

async function until<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function connectedExtension(agent: Agent) {
  const ext = await connect(agent.port, { origin: ORIGIN });
  expect(await ext.next()).toMatchObject({ type: 'server.info', app: 'pickfix', protocol: 3 });
  ext.send({ v: 1, type: 'hello', protocol: 3, client: { extensionVersion: '0.1.0', browser: 'e2e' } });
  expect(await ext.next()).toMatchObject({ type: 'welcome', session: { agent: 'e2e-agent' } });
  return ext;
}

describe('pickfix-mcp end to end', () => {
  it('connects, receives a batch, announces it, and streams claim and report back', async () => {
    const home = tempHome();
    const repo = realpathSync(tempDir());
    const agent = await startAgent(home, repo);
    const ext = await connectedExtension(agent);

    ext.send({ v: 1, type: 'batch.submit', requestId: 'r1', batch: makeBatch() });
    expect(await ext.next()).toMatchObject({ type: 'batch.accepted', batchId: 'batch-1', status: 'queued' });

    const event = await until(() => agent.notifications.find((n) => n.method === 'notifications/claude/channel'));
    expect(event.params).toMatchObject({ meta: { batch_id: 'batch-1', items: '1', path: '/checkout' } });

    const claim = (await agent.client.callTool({ name: 'pickfix_claim_batch', arguments: { batchId: 'batch-1' } })) as {
      content: { type: string }[];
    };
    expect(textOf(claim)).toContain('# Pickfix batch batch-1');
    expect(claim.content.some((c) => c.type === 'image')).toBe(true);
    expect(await ext.next()).toMatchObject({ type: 'batch.status', batchId: 'batch-1', status: 'working' });

    await agent.client.callTool({
      name: 'pickfix_report',
      arguments: { batchId: 'batch-1', outcome: 'done', summary: 'Made the button full-width in CheckoutSummary.tsx.', items: [{ itemId: 'item-1', outcome: 'done' }] },
    });
    expect(await ext.next()).toMatchObject({
      type: 'batch.status',
      status: 'done',
      report: { summary: 'Made the button full-width in CheckoutSummary.tsx.', items: [{ itemId: 'item-1', outcome: 'done' }] },
    });
  });

  it('carries a region item with reference images from the extension to the claim', async () => {
    const agent = await startAgent(tempHome(), realpathSync(tempDir()));
    const ext = await connectedExtension(agent);
    const item = { ...makeRegionItem('item-1'), comment: '', attachments: [makeAttachment('a.png'), makeAttachment('b.png')] };
    ext.send({ v: 1, type: 'batch.submit', requestId: 'r1', batch: makeBatch({ id: 'batch-r', items: [item] }) });
    expect(await ext.next()).toMatchObject({ type: 'batch.accepted', batchId: 'batch-r', status: 'queued' });
    const claim = (await agent.client.callTool({ name: 'pickfix_claim_batch', arguments: { batchId: 'batch-r' } })) as {
      content: { type: string }[];
    };
    const md = textOf(claim);
    expect(md).toContain('## Item 1 of 1 · region · `item-1`');
    expect(md).toContain('The reviewer wrote no description. Make the target match the attached reference image(s).');
    expect(md).toContain('**Reference images (desired look, provided by the reviewer):**');
    expect(claim.content.filter((c) => c.type === 'image')).toHaveLength(3);
  });

  it('refuses a web page origin and tells an old extension to update', async () => {
    const agent = await startAgent(tempHome(), realpathSync(tempDir()));
    expect(await rejectedStatus(agent.port, { origin: 'http://evil.test' })).toBe(403);
    const ext = await connect(agent.port, { origin: ORIGIN });
    await ext.next();
    ext.send({ v: 1, type: 'hello', protocol: 1, token: 'f'.repeat(64), client: { extensionVersion: '0.1.0', browser: 'e2e' } });
    expect(await ext.next()).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
  });

  it('a second session on the same repo takes the next port and shares the queue', async () => {
    const home = tempHome();
    const repo = realpathSync(tempDir());
    const first = await startAgent(home, repo);
    const ext = await connectedExtension(first);
    ext.send({ v: 1, type: 'batch.submit', requestId: 'r1', batch: makeBatch() });
    await ext.next();
    const second = await startAgent(home, repo);
    expect(second.port).not.toBe(first.port);
    expect(textOf(await second.client.callTool({ name: 'pickfix_list_batches', arguments: {} }))).toContain('batch-1 · queued');
  });

  it('re-queues a batch whose session died mid-fix and announces it to the next session', async () => {
    const home = tempHome();
    const repo = realpathSync(tempDir());
    const first = await startAgent(home, repo);
    const ext = await connectedExtension(first);
    ext.send({ v: 1, type: 'batch.submit', requestId: 'r1', batch: makeBatch() });
    await ext.next();
    const claimed = await first.client.callTool({ name: 'pickfix_claim_batch', arguments: {} });
    expect(textOf(claimed)).toContain('# Pickfix batch batch-1');
    expect(await ext.next()).toMatchObject({ type: 'batch.status', batchId: 'batch-1', status: 'working' });
    const pid = first.pid;
    expect(pid).toBeGreaterThan(0);
    await first.close();
    running.splice(running.indexOf(first), 1);
    await until(() => (alive(pid!) ? undefined : true), 5000);

    const next = await startAgent(home, repo);
    expect(textOf(await next.client.callTool({ name: 'pickfix_list_batches', arguments: {} }))).toContain('batch-1 · queued');
    await until(() => next.notifications.find((n) => (n.params?.meta as { batch_id?: string } | undefined)?.batch_id === 'batch-1'));
  });

  it('imports an exported batch file', async () => {
    const repo = realpathSync(tempDir());
    writeFileSync(join(repo, 'export.json'), JSON.stringify(makeBatch({ id: 'exported' })));
    const agent = await startAgent(tempHome(), repo);
    expect(textOf(await agent.client.callTool({ name: 'pickfix_import', arguments: { path: 'export.json' } }))).toContain('Imported batch exported');
  });
});
