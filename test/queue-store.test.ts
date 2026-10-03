import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QueueStore } from '../src/queue-store.js';
import * as fsJson from '../src/fs-json.js';
import { makeBatch, makeElementItem, PNG_1PX } from '../packages/protocol/test/fixtures.js';
import { tempDir, tempHome } from './helpers.js';

vi.mock('../src/fs-json.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/fs-json.js')>();
  return { ...real, writeJson: vi.fn(real.writeJson) };
});

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

  it('recovers from quarantined batch and resubmits the same id with screenshots preserved', () => {
    const { store } = newStore();
    store.add(makeBatch(), 's');
    writeFileSync(join(store.dir, 'batch-1', 'state.json'), '{broken');
    store.list(); // Quarantines the corrupt state.json
    // Now try to add the same batch id again
    const { record, created } = store.add(makeBatch(), 's');
    expect(created).toBe(true);
    expect(record.state.status).toBe('queued');
    // Verify the screenshot from the retry is preserved
    expect(store.screenshotBase64('batch-1', record.batch.items[0]!)).toBe(PNG_1PX);
  });

  it('validates batch id and all item ids before any filesystem work', () => {
    const { store } = newStore();
    expect(() => {
      store.add(makeBatch({ id: '../x' }), 's');
    }).toThrow('Invalid batch id');
    // Directory should not have been created since we errored before ensureDir
    expect(existsSync(store.dir)).toBe(false);

    expect(() => {
      store.add(makeBatch({ items: [makeElementItem('../evil')] }), 's');
    }).toThrow('Invalid item id');
    // Directory should still not exist
    expect(existsSync(store.dir)).toBe(false);
  });

  it('removes its temporary directory when writing fails midway', async () => {
    const real = (await vi.importActual<typeof import('../src/fs-json.js')>('../src/fs-json.js')).writeJson;
    const { store } = newStore();
    vi.mocked(fsJson.writeJson).mockImplementation((file, data) => {
      if (String(file).includes('.tmp-')) throw new Error('disk full');
      return real(file, data);
    });
    try {
      expect(() => store.add(makeBatch(), 's')).toThrow('disk full');
      expect(readdirSync(store.dir).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    } finally {
      vi.mocked(fsJson.writeJson).mockImplementation(real);
    }
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

  it('skips a corrupt batch.json', () => {
    const { store, logs } = newStore();
    store.add(makeBatch(), 's');
    writeFileSync(join(store.dir, 'batch-1', 'batch.json'), '{broken');
    expect(store.list()).toEqual([]);
    expect(readdirSync(join(store.dir, 'batch-1')).some((n) => n.startsWith('batch.json.corrupt-'))).toBe(true);
    expect(logs.join('\n')).toContain('corrupt');
  });

  it('skips a malformed batch.json with wrong shape', () => {
    const { store, logs } = newStore();
    store.add(makeBatch(), 's');
    writeFileSync(join(store.dir, 'batch-1', 'batch.json'), '{}');
    expect(store.list()).toEqual([]);
    expect(logs.join('\n')).toContain('Skipping malformed batch batch-1');
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
