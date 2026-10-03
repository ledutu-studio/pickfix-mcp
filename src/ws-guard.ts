import type { IncomingHttpHeaders } from 'node:http';
import { EXTENSION_ID, WS_PATH } from '@pickfix/protocol';

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env.PICKFIX_EXTENSION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return new Set([EXTENSION_ID, ...extra].map((id) => `chrome-extension://${id}`));
}

export function checkUpgrade(
  req: { url?: string; headers: IncomingHttpHeaders },
  port: number,
  origins: Set<string>,
): { ok: true } | { ok: false; status: 403 | 404; reason: string } {
  const path = (req.url ?? '').split('?')[0];
  if (path !== WS_PATH) return { ok: false, status: 404, reason: 'Unknown path.' };
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 403, reason: 'Host is not a loopback address of this server.' };
  }
  const origin = req.headers.origin;
  if (!origin || !origins.has(origin)) return { ok: false, status: 403, reason: 'Origin is not the PickFix extension.' };
  return { ok: true };
}

/** Counts events in a sliding time window. */
export class WindowCounter {
  private events: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.events = this.events.filter((t) => t > cutoff);
  }

  record(): void {
    this.prune();
    this.events.push(this.now());
  }

  exceeded(): boolean {
    this.prune();
    return this.events.length >= this.limit;
  }
}
