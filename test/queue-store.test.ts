import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueueStore } from '../src/queue-store.js';
import { makeBatch, makeElementItem, PNG_1PX } from '../packages/protocol/test/fixtures.js';
import { tempDir, tempHome } from './helpers.js';

function newStore(home = tempHome(), repoRoot = tempDir(), clock = { t: Date.parse('2026-10-02T10:00:00Z') }) {
  const logs: string[] = [];
  const store = new QueueStore({ home, repoRoot, now: () => new Date(clock.t), log: (m) => logs.push(m) });
  return { store, home, repoRoot, clock, logs };
}

describe('QueueStore.add', () => {
  it('stores the batch, its state and its screenshots under the repo key', () => {
    const { store, repoRoot } = newStore();
    const { record, created } = store.add(makeBatch(), 'session-a');
    expect(created).toBe(true);
    expect(record.state).toMatchObject({ status: 'queued', receivedAt: '2026-10-02T10:00:00.000Z' });
    expect(record.state.history).toEqual([{ status: 'queued', at: '2026-10-02T10:00:00.000Z', sessionId: 'session-a' }]);
    const dir = join(store.dir, 'batch-1');
    expect(readFileSync(join(dir, 'item-1.png')).toString('base64')).toBe(PNG_1PX);
    const stored = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8'));
    expect(stored.items[0].screenshot).toEqual({ mime: 'image/png', width: 1, height: 1, region: 'element', clipped: false, file: 'item-1.png' });
    expect(JSON.parse(readFileSync(join(store.dir, 'repo.json'), 'utf8'))).toEqual({ cwd: repoRoot });
  });

  it('is idempotent by batch id', () => {
    const { store } = newStore();
    store.add(makeBatch(), 's');
    const again = store.add(makeBatch({ items: [makeElementItem('other')] }), 's');
    expect(again.created).toBe(false);
    expect(again.record.batch.items[0]?.id).toBe('item-1');
  });

  it('leaves no temporary directories behind', () => {
    const { store } = newStore();
    store.add(makeBatch(), 's');
    expect(readdirSync(store.dir).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('shares one queue between two stores on the same repo', () => {
    const home = tempHome();
    const repoRoot = tempDir();
    const a = newStore(home, repoRoot).store;
    const b = newStore(home, repoRoot).store;
    a.add(makeBatch(), 's');
    expect(b.get('batch-1')?.state.status).toBe('queued');
  });
});

describe('QueueStore.list', () => {
  it('lists batches oldest first, filtered by status', () => {
    const { store, clock } = newStore();
    store.add(makeBatch({ id: 'b2' }), 's');
    clock.t += 1000;
    store.add(makeBatch({ id: 'b1', page: { url: 'http://localhost:3000/cart', path: '/cart', title: 'Cart' } }), 's');
    expect(store.list().map((s) => s.id)).toEqual(['b2', 'b1']);
    expect(store.list(['queued'])[1]).toMatchObject({ id: 'b1', items: 1, path: '/cart', origin: 'localhost:3000', status: 'queued' });
    expect(store.list(['working'])).toEqual([]);
  });

  it('skips and quarantines a corrupt state file', () => {
    const { store, logs } = newStore();
    store.add(makeBatch(), 's');
    writeFileSync(join(store.dir, 'batch-1', 'state.json'), '{broken');
    expect(store.list()).toEqual([]);
    expect(readdirSync(join(store.dir, 'batch-1')).some((n) => n.startsWith('state.json.corrupt-'))).toBe(true);
    expect(logs.join('\n')).toContain('corrupt');
  });
});

describe('QueueStore screenshots', () => {
  it('returns base64 and a path for stored screenshots', () => {
    const { store } = newStore();
    const { record } = store.add(makeBatch(), 's');
    const item = record.batch.items[0]!;
    expect(store.screenshotBase64('batch-1', item)).toBe(PNG_1PX);
    expect(existsSync(store.screenshotPath('batch-1', item)!)).toBe(true);
  });
});
