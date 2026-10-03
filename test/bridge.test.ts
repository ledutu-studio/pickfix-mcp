import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, type Session } from '@pickfix/protocol';
import { startBridge, type Bridge } from '../src/bridge.js';
import { QueueStore, type BatchRecord } from '../src/queue-store.js';
import { allowedOrigins } from '../src/ws-guard.js';
import { makeBatch } from '../packages/protocol/test/fixtures.js';
import { tempDir, tempHome } from './helpers.js';
import { freePorts } from './net-helpers.js';
import { connect, rejectedStatus, type TestClient } from './ws-client.js';

const session: Session = { sessionId: 'session-a', name: 'shop', cwd: '/Users/dev/shop', startedAt: '2026-10-02T10:00:00Z', agent: 'claude-code', pid: process.pid };
const hello = (token: string) => ({ v: 1, type: 'hello', protocol: 1, token, client: { extensionVersion: '0.1.0', browser: 'test' } });

let bridge: Bridge;
let store: QueueStore;
let token: string | null;
let pairing: 'ok' | 'invalid' | 'expired' | 'none';
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
      readToken: () => token,
      redeemPairing: () => pairing,
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
  expect(await client.next()).toMatchObject({ type: 'server.info', app: 'pickfix', protocol: 1 });
  client.send(hello('t'.repeat(64)));
  expect(await client.next()).toEqual({ v: 1, type: 'welcome', session });
  return client;
}

beforeEach(async () => {
  home = tempHome();
  repoRoot = tempDir();
  store = new QueueStore({ home, repoRoot, log: () => {} });
  token = 't'.repeat(64);
  pairing = 'none';
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
});

describe('authentication', () => {
  it('welcomes the right token', async () => {
    await authed();
  });

  it('refuses a wrong token and closes', async () => {
    const client = await connect(bridge.port);
    await client.next();
    client.send(hello('x'.repeat(64)));
    expect(await client.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect(await client.closed).toBe(1008);
  });

  it('reads the token on every hello, so a rotated token locks out the old one', async () => {
    await authed();
    token = 'n'.repeat(64);
    const client = await connect(bridge.port);
    await client.next();
    client.send(hello('t'.repeat(64)));
    expect(await client.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
  });

  it('refuses another protocol version', async () => {
    const client = await connect(bridge.port);
    await client.next();
    client.send({ ...hello('t'.repeat(64)), protocol: 2 });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
  });

  it('refuses batch messages before hello', async () => {
    const client = await connect(bridge.port);
    await client.next();
    client.send({ v: 1, type: 'batch.watch', batchIds: [] });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
  });

  it('closes a connection that never authenticates', async () => {
    await bridge.close();
    await start({ preAuthMs: 100 });
    const client = await connect(bridge.port);
    expect(await client.closed).toBe(1008);
  });

  it('hands out the token for a valid pairing code', async () => {
    pairing = 'ok';
    const client = await connect(bridge.port);
    await client.next();
    client.send({ v: 1, type: 'pair', code: '123456' });
    expect(await client.next()).toEqual({ v: 1, type: 'paired', token: 't'.repeat(64) });
    client.send(hello('t'.repeat(64)));
    expect(await client.next()).toMatchObject({ type: 'welcome' });
  });

  it('explains a failed pairing code', async () => {
    pairing = 'expired';
    const client = await connect(bridge.port);
    await client.next();
    client.send({ v: 1, type: 'pair', code: '123456' });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'pairing-failed', message: expect.stringContaining('expired') });
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
