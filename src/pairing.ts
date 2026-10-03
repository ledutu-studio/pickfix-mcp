import { randomInt } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome } from './home.js';
import { tokensEqual } from './token.js';

export const PAIRING_TTL_MS = 120_000;
export const MAX_PAIRING_ATTEMPTS = 5;

type PairingFile = { code: string; expiresAt: number; attempts: number };

function pairingPath(home: string): string {
  return join(home, 'pairing.json');
}

function write(home: string, data: PairingFile): void {
  ensureHome(home);
  const tmp = `${pairingPath(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, pairingPath(home));
}

function read(home: string): PairingFile | null {
  try {
    const data = JSON.parse(readFileSync(pairingPath(home), 'utf8')) as Partial<PairingFile>;
    if (typeof data.code !== 'string' || typeof data.expiresAt !== 'number' || typeof data.attempts !== 'number') return null;
    return data as PairingFile;
  } catch {
    return null;
  }
}

function remove(home: string): void {
  rmSync(pairingPath(home), { force: true });
}

export function createPairingCode(home: string, now = Date.now()): { code: string; expiresAt: number } {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = now + PAIRING_TTL_MS;
  write(home, { code, expiresAt, attempts: 0 });
  return { code, expiresAt };
}

/** One code is valid at a time per machine; every server on the machine shares the file. */
export function redeemPairingCode(home: string, code: string, now = Date.now()): 'ok' | 'invalid' | 'expired' | 'none' {
  const current = read(home);
  if (!current) return 'none';
  if (now > current.expiresAt) {
    remove(home);
    return 'expired';
  }
  if (tokensEqual(current.code, code)) {
    remove(home);
    return 'ok';
  }
  const attempts = current.attempts + 1;
  if (attempts >= MAX_PAIRING_ATTEMPTS) remove(home);
  else write(home, { ...current, attempts });
  return 'invalid';
}
