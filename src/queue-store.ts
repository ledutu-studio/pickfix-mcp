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
    return batch && state ? { batch, state } : undefined;
  }

  add(batch: Batch, sessionId: string): { record: BatchRecord; created: boolean } {
    const existing = this.get(batch.id);
    if (existing) return { record: existing, created: false };
    this.ensureDir();

    const at = this.now().toISOString();
    const tmp = join(this.dir, `.tmp-${batch.id}-${process.pid}-${randomBytes(4).toString('hex')}`);
    mkdirSync(tmp, { mode: 0o700 });
    const items: StoredItem[] = batch.items.map((item) => {
      if (!item.screenshot) return item as StoredItem;
      const { data, ...meta } = item.screenshot;
      const file = `${item.id}.${meta.mime === 'image/png' ? 'png' : 'jpg'}`;
      writeFileSync(join(tmp, file), Buffer.from(data, 'base64'), { mode: 0o600 });
      return { ...item, screenshot: { ...meta, file } };
    });
    const stored: StoredBatch = { ...batch, items };
    const state: BatchState = { status: 'queued', receivedAt: at, updatedAt: at, history: [{ status: 'queued', at, sessionId }] };
    writeJson(join(tmp, 'batch.json'), stored);
    writeJson(join(tmp, 'state.json'), state);
    try {
      renameSync(tmp, this.batchDir(batch.id));
    } catch {
      rmSync(tmp, { recursive: true, force: true });
      const raced = this.get(batch.id);
      if (raced) return { record: raced, created: false };
      throw new Error(`Could not store batch ${batch.id}.`);
    }
    return { record: { batch: stored, state }, created: true };
  }

  list(statuses?: BatchStatus[]): BatchSummary[] {
    if (!existsSync(this.dir)) return [];
    const summaries: BatchSummary[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!ID_PATTERN.test(name)) continue;
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
