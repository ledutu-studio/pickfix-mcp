import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { log as defaultLog } from './log.js';
import type { BatchRecord } from './queue-store.js';

/** Page paths are page-controlled; keep only URL path characters and a sane length. */
function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9\-._~/%[\]@:+]/g, '').slice(0, 200) || '/';
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'an unknown page';
  }
}

export function channelEvent(record: BatchRecord): { content: string; meta: { batch_id: string; items: string; path: string } } {
  const { id, items, page } = record.batch;
  const path = safePath(page.path);
  const count = `${items.length} item${items.length === 1 ? '' : 's'}`;
  return {
    content: `PickFix batch ${id}: ${count} on ${path} from ${safeOrigin(page.url)}. Claim it with pickfix_claim_batch { batchId: "${id}" }, make the fixes, then call pickfix_report.`,
    meta: { batch_id: id, items: String(items.length), path },
  };
}

/** Claude Code drops the event silently when the session did not load PickFix as a channel; the batch stays queued for pull. */
export async function announce(server: Server, record: BatchRecord, log: (message: string) => void = defaultLog): Promise<void> {
  try {
    // A Claude Code extension method, so it is not in the SDK's ServerNotification union.
    const notification = { method: 'notifications/claude/channel', params: channelEvent(record) };
    await server.notification(notification as unknown as ServerNotification);
  } catch (error) {
    log(`Could not announce batch ${record.batch.id}: ${(error as Error).message}`);
  }
}
