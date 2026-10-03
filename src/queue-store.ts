import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
      rmSync(tmp, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        // Directory exists; check if it's valid or quarantined
        const raced = this.get(batch.id);
        if (raced) {
          // Another process created a valid batch; use that
          return { record: raced, created: false };
        }
        // The existing directory is invalid (quarantined); move it aside and retry
        const quarantined = join(this.dir, `.corrupt-${batch.id}-${Date.now()}`);
        try {
          renameSync(this.batchDir(batch.id), quarantined);
          this.log(`Quarantined existing batch directory: ${quarantined}`);
        } catch {
          // Could not quarantine; rethrow original error
          throw new Error(`Could not store batch ${batch.id}.`, { cause: error });
        }
        // Retry the temp directory move once
        const tmpRetry = join(this.dir, `.tmp-${batch.id}-${process.pid}-${randomBytes(4).toString('hex')}`);
        try {
          mkdirSync(tmpRetry, { mode: 0o700 });
          writeJson(join(tmpRetry, 'batch.json'), stored);
          writeJson(join(tmpRetry, 'state.json'), state);
          renameSync(tmpRetry, this.batchDir(batch.id));
        } catch (retryError) {
          rmSync(tmpRetry, { recursive: true, force: true });
          throw new Error(`Could not store batch ${batch.id}.`, { cause: retryError });
        }
      } else {
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
}
