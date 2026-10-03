import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function pickfixHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PICKFIX_HOME ?? join(homedir(), '.pickfix');
}

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
}
