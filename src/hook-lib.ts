import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PATTERN } from '@pickfix/protocol';
import { readJson } from './fs-json.js';
import { repoKey } from './repo.js';

export function queuedCount(home: string, repoRoot: string): number {
  const dir = join(home, 'queue', repoKey(repoRoot));
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (!ID_PATTERN.test(name)) continue;
    const state = readJson<{ status?: string }>(join(dir, name, 'state.json'), () => {});
    if (state?.status === 'queued') count++;
  }
  return count;
}

export function hookOutput(count: number): string | null {
  if (count === 0) return null;
  const what = count === 1 ? '1 feedback batch from the browser extension is' : `${count} feedback batches from the browser extension are`;
  const it = count === 1 ? 'it' : 'them';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `PickFix: ${what} waiting for this repository. Run /pickfix:fix to handle ${it}, or ignore this if the user is asking about something else.`,
    },
  });
}
