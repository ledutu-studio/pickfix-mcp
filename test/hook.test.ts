import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hookOutput, queuedCount } from '../src/hook-lib.js';
import { QueueStore } from '../src/queue-store.js';
import { makeBatch } from '../packages/protocol/test/fixtures.js';
import { tempDir, tempHome } from './helpers.js';

describe('queuedCount', () => {
  it('counts only queued batches of this repository', () => {
    const home = tempHome();
    const repo = realpathSync(tempDir());
    const store = new QueueStore({ home, repoRoot: repo, log: () => {} });
    store.add(makeBatch({ id: 'a' }), 's');
    store.add(makeBatch({ id: 'b' }), 's');
    store.claim('s', process.pid, 'b');
    new QueueStore({ home, repoRoot: realpathSync(tempDir()), log: () => {} }).add(makeBatch({ id: 'other-repo' }), 's');
    expect(queuedCount(home, repo)).toBe(1);
  });

  it('is zero when there is no queue at all', () => {
    expect(queuedCount(tempHome(), '/nowhere')).toBe(0);
  });
});

describe('hookOutput', () => {
  it('prints nothing when nothing waits', () => {
    expect(hookOutput(0)).toBeNull();
  });

  it('adds context in the UserPromptSubmit shape', () => {
    expect(JSON.parse(hookOutput(1)!)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          'PickFix: 1 feedback batch from the browser extension is waiting for this repository. Run /pickfix:fix to handle it, or ignore this if the user is asking about something else.',
      },
    });
    expect(JSON.parse(hookOutput(2)!).hookSpecificOutput.additionalContext).toContain('2 feedback batches from the browser extension are waiting');
  });
});
