import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PATTERN, type Batch, type BatchReport, type BatchStatus, type Item, type Screenshot } from '@pickfix/protocol';
import { readJson, writeJson } from './fs-json.js';
import { ensureHome } from './home.js';
import { log as defaultLog } from './log.js';
import { repoKey } from './repo.js';

export type BatchState = {
  status: BatchStatus;
  receivedAt: string;
  updatedAt: string;
  note?: string;
  report?: BatchReport;
  history: { status: BatchStatus; at: string; sessionId: string }[];
};

export type StoredScreenshot = Omit<Screenshot, 'data'> & { file: string };
export type StoredItem = Omit<Item, 'screenshot'> & { screenshot?: StoredScreenshot };
export type StoredBatch = Omit<Batch, 'items'> & { items: StoredItem[] };
export type BatchRecord = { batch: StoredBatch; state: BatchState };

export type BatchSummary = {
  id: string;
  items: number;
  path: string;
  origin: string;
  receivedAt: string;
  updatedAt: string;
  status: BatchStatus;
};

export type QueueStoreOptions = {
  home: string;
  repoRoot: string;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  log?: (message: string) => void;
};

function originOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export type ClaimOwner = { sessionId: string; pid: number; at: string; kind: 'claim' | 'cancel' };

export type ClaimResult =
  | { ok: true; record: BatchRecord }
  | { ok: false; reason: 'none-queued' | 'not-found' | 'already-claimed' | 'cancelled' | 'finished' };
export type ReportResult =
  | { ok: true; state: BatchState }
  | { ok: false; reason: 'not-found' | 'not-claimed' | 'claimed-by-other' | 'already-reported' };
export type CancelResult = { ok: true; state: BatchState } | { ok: false; reason: 'not-found' | 'conflict' };

const FINISHED: readonly BatchStatus[] = ['done', 'partial', 'failed', 'cancelled'];
const WEEK_MS = 7 * 24 * 3600 * 1000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class QueueStore {
  readonly dir: string;
  protected readonly now: () => Date;
  protected readonly log: (message: string) => void;

  constructor(protected readonly opts: QueueStoreOptions) {
    this.dir = join(opts.home, 'queue', repoKey(opts.repoRoot));
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? defaultLog;
  }

  protected batchDir(batchId: string): string {
    if (!ID_PATTERN.test(batchId)) throw new Error(`Invalid batch id "${batchId}".`);
    return join(this.dir, batchId);
  }

  protected ensureDir(): void {
    ensureHome(this.opts.home);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const repoFile = join(this.dir, 'repo.json');
    if (!existsSync(repoFile)) writeJson(repoFile, { cwd: this.opts.repoRoot });
  }

  protected writeState(batchId: string, state: BatchState): void {
    writeJson(join(this.batchDir(batchId), 'state.json'), state);
  }

  readState(batchId: string): BatchState | undefined {
    if (!ID_PATTERN.test(batchId)) return undefined;
    return readJson<BatchState>(join(this.dir, batchId, 'state.json'), this.log);
  }

  get(batchId: string): BatchRecord | undefined {
    if (!ID_PATTERN.test(batchId)) return undefined;
    const batch = readJson<StoredBatch>(join(this.dir, batchId, 'batch.json'), this.log);
    const state = this.readState(batchId);

    // Validate minimal shape
    if (batch && state) {
      try {
        if (!Array.isArray(batch.items)) {
          this.log(`Skipping malformed batch ${batchId}: items is not an array`);
          return undefined;
        }
        if (!batch.page || typeof batch.page.path !== 'string' || typeof batch.page.url !== 'string') {
          this.log(`Skipping malformed batch ${batchId}: page missing or invalid`);
          return undefined;
        }
        if (typeof state.status !== 'string' || !Array.isArray(state.history)) {
          this.log(`Skipping malformed batch ${batchId}: state missing or invalid`);
          return undefined;
        }
        return { batch, state };
      } catch {
        this.log(`Skipping malformed batch ${batchId}`);
        return undefined;
      }
    }
    return undefined;
  }

  add(batch: Batch, sessionId: string): { record: BatchRecord; created: boolean } {
    // Validate IDs before any filesystem work
    if (!ID_PATTERN.test(batch.id)) throw new Error(`Invalid batch id "${batch.id}".`);
    for (const item of batch.items) {
      if (!ID_PATTERN.test(item.id)) throw new Error(`Invalid item id "${item.id}".`);
    }

    const existing = this.get(batch.id);
    if (existing) return { record: existing, created: false };
    this.ensureDir();

    const at = this.now().toISOString();
    const tmp = join(this.dir, `.tmp-${batch.id}-${process.pid}-${randomBytes(4).toString('hex')}`);
    let stored: StoredBatch;
    let state: BatchState;

    try {
      mkdirSync(tmp, { mode: 0o700 });
      const items: StoredItem[] = batch.items.map((item) => {
        if (!item.screenshot) return item as StoredItem;
        const { data, ...meta } = item.screenshot;
        const file = `${item.id}.${meta.mime === 'image/png' ? 'png' : 'jpg'}`;
        writeFileSync(join(tmp, file), Buffer.from(data, 'base64'), { mode: 0o600 });
        return { ...item, screenshot: { ...meta, file } };
      });
      stored = { ...batch, items };
      state = { status: 'queued', receivedAt: at, updatedAt: at, history: [{ status: 'queued', at, sessionId }] };
      writeJson(join(tmp, 'batch.json'), stored);
      writeJson(join(tmp, 'state.json'), state);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      throw error;
    }

    // Try to move temp dir to final location, handling race conditions
    try {
      renameSync(tmp, this.batchDir(batch.id));
    } catch (error) {
      const errCode = (error as NodeJS.ErrnoException).code;
      if ((errCode === 'ENOTEMPTY' || errCode === 'EEXIST') && !this.get(batch.id)) {
        // Directory exists but invalid (quarantined); move it aside and retry with same tmp
        const quarantined = join(this.dir, `.corrupt-${batch.id}-${Date.now()}`);
        try {
          renameSync(this.batchDir(batch.id), quarantined);
          this.log(`Quarantined existing batch directory: ${quarantined}`);
        } catch {
          // Could not quarantine; clean up tmp and rethrow
          rmSync(tmp, { recursive: true, force: true });
          throw new Error(`Could not store batch ${batch.id}.`, { cause: error });
        }
        // Retry the move with the same tmp dir (which has screenshots)
        try {
          renameSync(tmp, this.batchDir(batch.id));
        } catch (retryError) {
          rmSync(tmp, { recursive: true, force: true });
          throw new Error(`Could not store batch ${batch.id}.`, { cause: retryError });
        }
      } else {
        rmSync(tmp, { recursive: true, force: true });
        if (errCode === 'ENOTEMPTY' || errCode === 'EEXIST') {
          // Directory exists and valid; use it
          const raced = this.get(batch.id);
          if (raced) return { record: raced, created: false };
        }
        throw new Error(`Could not store batch ${batch.id}.`, { cause: error });
      }
    }

    return { record: { batch: stored, state }, created: true };
  }

  list(statuses?: BatchStatus[]): BatchSummary[] {
    if (!existsSync(this.dir)) return [];
    const summaries: BatchSummary[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!ID_PATTERN.test(name)) continue;
      try {
        const record = this.get(name);
        if (!record) continue;
        if (statuses && !statuses.includes(record.state.status)) continue;
        summaries.push({
          id: name,
          items: record.batch.items.length,
          path: record.batch.page.path,
          origin: originOf(record.batch.page.url),
          receivedAt: record.state.receivedAt,
          updatedAt: record.state.updatedAt,
          status: record.state.status,
        });
      } catch (error) {
        this.log(`Error processing batch ${name}: ${(error as Error).message}`);
      }
    }
    return summaries.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  }

  screenshotPath(batchId: string, item: StoredItem): string | undefined {
    if (!item.screenshot) return undefined;
    const path = join(this.batchDir(batchId), item.screenshot.file);
    return existsSync(path) ? path : undefined;
  }

  screenshotBase64(batchId: string, item: StoredItem): string | undefined {
    const path = this.screenshotPath(batchId, item);
    return path ? readFileSync(path).toString('base64') : undefined;
  }

  protected claimDir(batchId: string): string {
    return join(this.batchDir(batchId), 'claim');
  }

  /** mkdir is atomic: whoever creates claim/ owns the batch, for a claim or a cancel. */
  protected takeClaim(batchId: string, owner: ClaimOwner): boolean {
    try {
      mkdirSync(this.claimDir(batchId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    try {
      writeJson(join(this.claimDir(batchId), 'owner.json'), owner);
    } catch (error) {
      rmSync(this.claimDir(batchId), { recursive: true, force: true });
      throw error;
    }
    return true;
  }

  protected transition(batchId: string, state: BatchState, status: BatchStatus, sessionId: string, extra: Partial<BatchState> = {}): BatchState {
    const at = this.now().toISOString();
    const next: BatchState = { ...state, ...extra, status, updatedAt: at, history: [...state.history, { status, at, sessionId }] };
    if (!('note' in extra)) delete next.note;
    this.writeState(batchId, next);
    return next;
  }

  owner(batchId: string): ClaimOwner | undefined {
    if (!ID_PATTERN.test(batchId)) return undefined;
    return readJson<ClaimOwner>(join(this.dir, batchId, 'claim', 'owner.json'), this.log);
  }

  claim(sessionId: string, pid: number, batchId?: string): ClaimResult {
    if (batchId !== undefined) return this.claimOne(sessionId, pid, batchId);
    for (const summary of this.list(['queued'])) {
      const result = this.claimOne(sessionId, pid, summary.id);
      if (result.ok) return result;
    }
    return { ok: false, reason: 'none-queued' };
  }

  protected claimOne(sessionId: string, pid: number, batchId: string): ClaimResult {
    const record = this.get(batchId);
    if (!record) return { ok: false, reason: 'not-found' };
    if (record.state.status === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (FINISHED.includes(record.state.status)) return { ok: false, reason: 'finished' };
    if (record.state.status !== 'queued') return { ok: false, reason: 'already-claimed' };
    if (!this.takeClaim(batchId, { sessionId, pid, at: this.now().toISOString(), kind: 'claim' })) {
      return { ok: false, reason: this.readState(batchId)?.status === 'cancelled' ? 'cancelled' : 'already-claimed' };
    }
    try {
      const state = this.transition(batchId, record.state, 'working', sessionId);
      return { ok: true, record: { batch: record.batch, state } };
    } catch (error) {
      rmSync(this.claimDir(batchId), { recursive: true, force: true });
      throw error;
    }
  }

  report(sessionId: string, batchId: string, report: BatchReport): ReportResult {
    const state = this.readState(batchId);
    if (!state) return { ok: false, reason: 'not-found' };
    if (FINISHED.includes(state.status)) return { ok: false, reason: 'already-reported' };
    if (state.status !== 'working') return { ok: false, reason: 'not-claimed' };
    if (this.owner(batchId)?.sessionId !== sessionId) return { ok: false, reason: 'claimed-by-other' };
    return { ok: true, state: this.transition(batchId, state, report.outcome, sessionId, { report }) };
  }

  cancel(sessionId: string, batchId: string): CancelResult {
    const state = this.readState(batchId);
    if (!state) return { ok: false, reason: 'not-found' };
    if (state.status === 'cancelled') return { ok: true, state };
    if (state.status !== 'queued') return { ok: false, reason: 'conflict' };
    if (!this.takeClaim(batchId, { sessionId, pid: process.pid, at: this.now().toISOString(), kind: 'cancel' })) {
      return { ok: false, reason: 'conflict' };
    }
    try {
      return { ok: true, state: this.transition(batchId, state, 'cancelled', sessionId) };
    } catch (error) {
      rmSync(this.claimDir(batchId), { recursive: true, force: true });
      throw error;
    }
  }

  /** Atomically takes a claim dir away from whoever owns it; false if someone else got there first. */
  protected seizeClaim(batchId: string): string | undefined {
    const dead = `${this.claimDir(batchId)}.dead-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(this.claimDir(batchId), dead);
    } catch {
      return undefined;
    }
    return dead;
  }

  recover(): string[] {
    const isAlive = this.opts.isAlive ?? isProcessAlive;
    const recovered: string[] = [];
    for (const summary of this.list(['working', 'queued'])) {
      const id = summary.id;
      const owner = this.owner(id);
      if (owner && owner.kind === 'claim' && isAlive(owner.pid)) continue;
      if (summary.status === 'queued') {
        // A queued batch holding a claim dir is stuck, unless a claim or cancel is in flight right now.
        let stale: boolean;
        if (owner) stale = owner.kind === 'claim';
        else {
          try {
            stale = this.now().getTime() - statSync(this.claimDir(id)).mtimeMs > 60_000;
          } catch {
            continue;
          }
        }
        if (!stale) continue;
        const dead = this.seizeClaim(id);
        if (!dead) continue;
        rmSync(dead, { recursive: true, force: true });
        this.log(`Batch ${id} had a stale claim; it is free again.`);
        continue;
      }
      const dead = this.seizeClaim(id);
      if (!dead) continue;
      try {
        const state = this.readState(id);
        if (state?.status === 'working') {
          this.transition(id, state, 'queued', owner?.sessionId ?? 'recovery', { note: 'interrupted' });
          this.log(`Batch ${id} was interrupted and is queued again.`);
          recovered.push(id);
        }
      } finally {
        rmSync(dead, { recursive: true, force: true });
      }
    }
    return recovered;
  }

  prune(maxAgeMs = WEEK_MS): string[] {
    const cutoff = this.now().getTime() - maxAgeMs;
    const pruned: string[] = [];
    for (const summary of this.list(['done', 'partial', 'failed', 'cancelled'])) {
      if (Date.parse(summary.updatedAt) < cutoff) {
        rmSync(this.batchDir(summary.id), { recursive: true, force: true });
        pruned.push(summary.id);
      }
    }
    return pruned;
  }
}
