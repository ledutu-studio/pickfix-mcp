import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchReport } from '@pickfix/protocol';
import { describe, expect, it } from 'vitest';
import { QueueStore, isProcessAlive } from '../src/queue-store.js';
import { makeBatch } from '../packages/protocol/test/fixtures.js';
import { tempDir, tempHome } from './helpers.js';

const report: BatchReport = { outcome: 'done', summary: 'Made the button full-width.', changedFiles: ['src/a.tsx'], items: [] };

function setup(alive: Set<number> = new Set([process.pid])) {
  const home = tempHome();
  const repoRoot = tempDir();
  const clock = { t: Date.parse('2026-10-02T10:00:00Z') };
  const make = () => new QueueStore({ home, repoRoot, now: () => new Date(clock.t), isAlive: (pid) => alive.has(pid), log: () => {} });
  return { a: make(), b: make(), clock, alive };
}

describe('claim', () => {
  it('claims the oldest queued batch when no id is given', () => {
    const { a, clock } = setup();
    a.add(makeBatch({ id: 'first' }), 's');
    clock.t += 1000;
    a.add(makeBatch({ id: 'second' }), 's');
    const result = a.claim('session-a', 111);
    expect(result.ok && result.record.batch.id).toBe('first');
    expect(a.readState('first')?.status).toBe('working');
    expect(a.owner('first')).toMatchObject({ sessionId: 'session-a', pid: 111, kind: 'claim' });
  });

  it('lets exactly one of two sessions claim a batch', () => {
    const { a, b } = setup();
    a.add(makeBatch(), 's');
    const results = [a.claim('session-a', 1, 'batch-1'), b.claim('session-b', 2, 'batch-1')];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'already-claimed' });
  });

  it('hands a working batch back to the session that owns it, and refuses others', () => {
    const { a, b } = setup();
    a.add(makeBatch({ id: 'batch-1' }), 's');
    a.claim('session-a', 1, 'batch-1');
    const before = a.get('batch-1')!.state;
    const again = a.claim('session-a', 1, 'batch-1');
    expect(again.ok).toBe(true);
    expect(a.get('batch-1')!.state).toEqual(before);
    expect(a.get('batch-1')!.state.history).toHaveLength(2);
    expect(b.claim('session-b', 2, 'batch-1')).toEqual({ ok: false, reason: 'already-claimed' });
    expect(a.claim('session-a', 1)).toEqual({ ok: false, reason: 'none-queued' });
  });

  it('skips claimed batches when picking the oldest', () => {
    const { a, b, clock } = setup();
    a.add(makeBatch({ id: 'first' }), 's');
    clock.t += 1000;
    a.add(makeBatch({ id: 'second' }), 's');
    a.claim('session-a', 1, 'first');
    const result = b.claim('session-b', 2);
    expect(result.ok && result.record.batch.id).toBe('second');
  });

  it('explains why nothing can be claimed', () => {
    const { a } = setup();
    expect(a.claim('s', 1)).toEqual({ ok: false, reason: 'none-queued' });
    expect(a.claim('s', 1, 'nope')).toEqual({ ok: false, reason: 'not-found' });
    a.add(makeBatch(), 's');
    a.cancel('s', 'batch-1');
    expect(a.claim('s', 1, 'batch-1')).toEqual({ ok: false, reason: 'cancelled' });
  });
});

describe('report', () => {
  it('finishes a batch claimed by the same session', () => {
    const { a } = setup();
    a.add(makeBatch(), 's');
    a.claim('session-a', 1, 'batch-1');
    const result = a.report('session-a', 'batch-1', report);
    expect(result.ok && result.state).toMatchObject({ status: 'done', report });
  });

  it('refuses reports for unclaimed, foreign and finished batches', () => {
    const { a } = setup();
    a.add(makeBatch(), 's');
    expect(a.report('session-a', 'batch-1', report)).toEqual({ ok: false, reason: 'not-claimed' });
    a.claim('session-a', 1, 'batch-1');
    expect(a.report('session-b', 'batch-1', report)).toEqual({ ok: false, reason: 'claimed-by-other' });
    a.report('session-a', 'batch-1', report);
    expect(a.report('session-a', 'batch-1', report)).toEqual({ ok: false, reason: 'already-reported' });
    expect(a.report('session-a', 'missing', report)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('cancel', () => {
  it('cancels a queued batch but not a claimed one', () => {
    const { a } = setup();
    a.add(makeBatch({ id: 'q' }), 's');
    a.add(makeBatch({ id: 'w' }), 's');
    a.claim('s', 1, 'w');
    expect(a.cancel('s', 'q')).toMatchObject({ ok: true, state: { status: 'cancelled' } });
    expect(a.cancel('s', 'q')).toMatchObject({ ok: true });
    expect(a.cancel('s', 'w')).toEqual({ ok: false, reason: 'conflict' });
    expect(a.cancel('s', 'missing')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('recover', () => {
  it('puts a working batch of a dead process back in the queue', () => {
    const { a, b, alive } = setup(new Set([42]));
    a.add(makeBatch(), 's');
    a.claim('session-a', 42, 'batch-1');
    expect(b.recover()).toEqual([]);
    alive.delete(42);
    expect(b.recover()).toEqual(['batch-1']);
    expect(b.readState('batch-1')).toMatchObject({ status: 'queued', note: 'interrupted' });
    expect(existsSync(join(b.dir, 'batch-1', 'claim'))).toBe(false);
    expect(b.claim('session-b', 7, 'batch-1').ok).toBe(true);
  });
});

describe('recover safety', () => {
  it('lets exactly one of two stores recover a dead-owner batch', () => {
    const { a, b, alive } = setup(new Set([42]));
    a.add(makeBatch(), 's');
    a.claim('session-a', 42, 'batch-1');
    alive.delete(42);
    const results = [a.recover(), b.recover()];
    expect(results.flat()).toEqual(['batch-1']);
    expect(results.filter((r) => r.length === 0)).toHaveLength(1);
    expect(a.readState('batch-1')?.status).toBe('queued');
  });

  it('refuses to claim a working batch that has no claim directory', () => {
    const { a } = setup();
    a.add(makeBatch(), 's');
    const file = join(a.dir, 'batch-1', 'state.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...state, status: 'working' }));
    expect(a.claim('s', 1, 'batch-1')).toEqual({ ok: false, reason: 'already-claimed' });
  });

  it('leaves a live fresh claim alone on a later recover', () => {
    const { a, b, alive } = setup(new Set([42]));
    a.add(makeBatch(), 's');
    a.claim('session-a', 42, 'batch-1');
    alive.delete(42);
    alive.add(7);
    expect(b.recover()).toEqual(['batch-1']);
    expect(b.claim('session-b', 7, 'batch-1').ok).toBe(true);
    expect(a.recover()).toEqual([]);
    expect(a.readState('batch-1')?.status).toBe('working');
    expect(a.owner('batch-1')).toMatchObject({ sessionId: 'session-b', pid: 7 });
  });

  it('frees a queued batch whose claim directory belongs to a dead process', () => {
    const { a, b, alive } = setup(new Set([42]));
    a.add(makeBatch(), 's');
    const dir = join(a.dir, 'batch-1', 'claim');
    mkdirSync(dir);
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ sessionId: 'x', pid: 99, at: 'now', kind: 'claim' }));
    expect(b.claim('s', 1, 'batch-1')).toEqual({ ok: false, reason: 'already-claimed' });
    expect(b.recover()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(alive.has(99)).toBe(false);
    expect(b.claim('s', 1, 'batch-1').ok).toBe(true);
  });

  it('frees an ownerless claim directory only after 60 seconds', () => {
    const { a, clock } = setup();
    a.add(makeBatch(), 's');
    const dir = join(a.dir, 'batch-1', 'claim');
    mkdirSync(dir);
    expect(a.recover()).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    clock.t = Date.now() + 120_000;
    a.recover();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('prune', () => {
  it('deletes finished batches older than seven days', () => {
    const { a, clock } = setup();
    a.add(makeBatch({ id: 'old' }), 's');
    a.claim('s', 1, 'old');
    a.report('s', 'old', report);
    a.add(makeBatch({ id: 'queued' }), 's');
    clock.t += 8 * 24 * 3600 * 1000;
    expect(a.prune()).toEqual(['old']);
    expect(a.list().map((s) => s.id)).toEqual(['queued']);
  });
});

describe('isProcessAlive', () => {
  it('knows this process is alive and a huge pid is not', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
