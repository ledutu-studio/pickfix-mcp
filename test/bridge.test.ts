import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, type Session } from '@pickfix/protocol';
import { startBridge, type Bridge } from '../src/bridge.js';
import { QueueStore, type BatchRecord } from '../src/queue-store.js';
import { allowedOrigins } from '../src/ws-guard.js';
import { makeBatch } from '../packages/protocol/test/fixtures.js';
import { tempDir, tempHome } from './helpers.js';
import { freePorts } from './net-helpers.js';
import { connect, rejectedStatus, type TestClient } from './ws-client.js';

const session: Session = { sessionId: 'session-a', name: 'shop', cwd: '/Users/dev/shop', startedAt: '2026-10-02T10:00:00Z', agent: 'claude-code', pid: process.pid };
const hello = () => ({ v: 1, type: 'hello', protocol: PROTOCOL_VERSION, client: { extensionVersion: '0.1.0', browser: 'test' } });

let bridge: Bridge;
let store: QueueStore;
let added: BatchRecord[];
let home: string;
let repoRoot: string;

async function start(overrides: { preAuthMs?: number } = {}) {
  const ports = await freePorts(2);
  bridge = (await startBridge(
    {
      session,
      serverVersion: '0.1.0',
      store,
      origins: allowedOrigins({}),
      onBatchAdded: (record) => added.push(record),
      log: () => {},
      watchIntervalMs: 50,
      ...overrides,
    },
    ports,
  ))!;
}

async function authed(): Promise<TestClient> {
  const client = await connect(bridge.port);
  expect(await client.next()).toMatchObject({ type: 'server.info', app: 'pickfix', protocol: PROTOCOL_VERSION });
  client.send(hello());
  expect(await client.next()).toEqual({ v: 1, type: 'welcome', session });
  return client;
}

beforeEach(async () => {
  home = tempHome();
  repoRoot = tempDir();
  store = new QueueStore({ home, repoRoot, log: () => {} });
  added = [];
  await start();
});

afterEach(async () => {
  await bridge.close();
});

describe('connection guard', () => {
  it('refuses a web page origin, a foreign host and another path', async () => {
    expect(await rejectedStatus(bridge.port, { origin: 'http://evil.test' })).toBe(403);
    expect(await rejectedStatus(bridge.port, { host: `evil.test:${bridge.port}` })).toBe(403);
    expect(await rejectedStatus(bridge.port, { path: '/other' })).toBe(404);
  });

  it('answers plain HTTP with 404 and no CORS headers', async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/pickfix`);
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers the extension\'s port probe (HEAD /), so the extension knows something listens', async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/`, { method: 'HEAD' });
    expect(res.status).toBe(404);
  });
});

describe('connection guard resilience', () => {
  it('survives a client that resets a refused upgrade', async () => {
    const socket = net.connect(bridge.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.on('error', () => {});
    socket.write(
      `GET /pickfix HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nOrigin: http://evil.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 10));
    socket.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 100));
    await authed();
  });
});

describe('handshake', () => {
  it('closes on invalid, too-large and rpc frames before authentication', async () => {
    const bad = await connect(bridge.port);
    await bad.next();
    bad.sendRaw('not json');
    expect(await bad.next()).toMatchObject({ type: 'error', code: 'invalid' });
    expect(await bad.closed).toBe(1008);
    const big = await connect(bridge.port);
    await big.next();
    big.sendRaw(`"${'x'.repeat(MAX_MESSAGE_BYTES)}"`);
    expect(await big.next()).toMatchObject({ type: 'error', code: 'too-large' });
    expect(await big.closed).toBe(1008);
    const rpc = await connect(bridge.port);
    await rpc.next();
    rpc.sendRaw('{"v":1,"type":"rpc.request","requestId":"x","method":"reload"}');
    expect(await rpc.closed).toBe(1008);
  });

  it('welcomes a hello from the extension without any pairing', async () => {
    await authed();
  });

  it('answers a repeated hello with welcome again', async () => {
    const client = await authed();
    client.send(hello());
    expect(await client.next()).toEqual({ v: 1, type: 'welcome', session });
  });

  it('tells a protocol 1 extension (which still sends a pairing token) to update', async () => {
    const client = await connect(bridge.port);
    await client.next();
    client.send({ ...hello(), protocol: 1, token: 't'.repeat(64) });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
    expect(await client.closed).toBe(1008);
  });

  it('tells a protocol 2 extension to update, naming protocol 3', async () => {
    const client = await connect(bridge.port);
    await client.next();
    client.send({ ...hello(), protocol: 2 });
    const reply = await client.next();
    expect(reply).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
    expect(JSON.stringify(reply)).toContain('protocol 3');
    expect(await client.closed).toBe(1008);
  });

  it('no longer understands pairing messages', async () => {
    const client = await connect(bridge.port);
    await client.next();
    client.send({ v: 1, type: 'pair', code: '123456' });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'invalid' });
    expect(await client.closed).toBe(1008);
  });

  it('refuses batch messages before hello', async () => {
    const client = await connect(bridge.port);
    await client.next();
    client.send({ v: 1, type: 'batch.watch', batchIds: [] });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
  });

  it('closes a connection that never says hello', async () => {
    await bridge.close();
    await start({ preAuthMs: 100 });
    const client = await connect(bridge.port);
    expect(await client.closed).toBe(1008);
  });
});

describe('batches', () => {
  it('accepts a batch once and announces it once', async () => {
    const client = await authed();
    client.send({ v: 1, type: 'batch.submit', requestId: 'r1', batch: makeBatch() });
    expect(await client.next()).toEqual({ v: 1, type: 'batch.accepted', requestId: 'r1', batchId: 'batch-1', status: 'queued' });
    client.send({ v: 1, type: 'batch.submit', requestId: 'r2', batch: makeBatch() });
    expect(await client.next()).toMatchObject({ type: 'batch.accepted', requestId: 'r2', status: 'queued' });
    expect(added).toHaveLength(1);
  });

  it('reports an invalid message and ignores reserved rpc messages', async () => {
    const client = await authed();
    client.sendRaw('{"v":1,"type":"batch.submit","requestId":"r1"}');
    expect(await client.next()).toMatchObject({ type: 'error', code: 'invalid' });
    client.sendRaw('{"v":1,"type":"rpc.request","requestId":"x","method":"reload"}');
    client.send({ v: 1, type: 'ping' });
    expect(await client.next()).toEqual({ v: 1, type: 'pong' });
  });

  it('answers too-large and keeps the connection open', async () => {
    const client = await authed();
    client.sendRaw(`"${'x'.repeat(MAX_MESSAGE_BYTES)}"`);
    expect(await client.next()).toMatchObject({ type: 'error', code: 'too-large' });
    client.send({ v: 1, type: 'ping' });
    expect(await client.next()).toEqual({ v: 1, type: 'pong' });
  });

  it('rate-limits the 21st batch in a minute', async () => {
    const client = await authed();
    for (let i = 0; i < 20; i++) {
      client.send({ v: 1, type: 'batch.submit', requestId: `r${i}`, batch: makeBatch({ id: `b${i}` }) });
      expect(await client.next()).toMatchObject({ type: 'batch.accepted' });
    }
    client.send({ v: 1, type: 'batch.submit', requestId: 'r20', batch: makeBatch({ id: 'b20' }) });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'rate-limited', requestId: 'r20' });
  });

  it('pushes status changes made by this session and by another session on the repo', async () => {
    const client = await authed();
    client.send({ v: 1, type: 'batch.submit', requestId: 'r1', batch: makeBatch() });
    await client.next();
    store.claim('session-a', process.pid, 'batch-1');
    bridge.pushStatus('batch-1');
    expect(await client.next()).toMatchObject({ type: 'batch.status', batchId: 'batch-1', status: 'working' });
    const otherSession = new QueueStore({ home, repoRoot, log: () => {} });
    otherSession.report('session-a', 'batch-1', { outcome: 'done', summary: 'Fixed.', changedFiles: [], items: [] });
    expect(await client.next()).toMatchObject({ type: 'batch.status', status: 'done', report: { summary: 'Fixed.' } });
    await expect(client.next(150)).rejects.toThrow('No message');
  });

  it('answers batch.watch with the current status of known batches', async () => {
    store.add(makeBatch(), 'earlier-session');
    const client = await authed();
    client.send({ v: 1, type: 'batch.watch', batchIds: ['batch-1', 'unknown'] });
    expect(await client.next()).toMatchObject({ type: 'batch.status', batchId: 'batch-1', status: 'queued' });
  });

  it('cancels a queued batch and refuses to cancel a claimed one', async () => {
    store.add(makeBatch({ id: 'q' }), 's');
    store.add(makeBatch({ id: 'w' }), 's');
    store.claim('s', process.pid, 'w');
    const client = await authed();
    client.send({ v: 1, type: 'batch.cancel', requestId: 'c1', batchId: 'q' });
    expect(await client.next()).toMatchObject({ type: 'batch.status', batchId: 'q', status: 'cancelled' });
    client.send({ v: 1, type: 'batch.cancel', requestId: 'c2', batchId: 'w' });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'conflict', requestId: 'c2' });
  });
});
