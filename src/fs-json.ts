import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { log as defaultLog } from './log.js';

export function readJson<T>(file: string, log: (message: string) => void = defaultLog): T | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log(`Could not read ${file}: ${(error as Error).message}`);
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const quarantined = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, quarantined);
    } catch {
      // Another process may have quarantined it first.
    }
    log(`Moved a corrupt file aside: ${quarantined}`);
    return undefined;
  }
}

export function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
