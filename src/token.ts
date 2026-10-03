import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome } from './home.js';

const TOKEN = /^[0-9a-f]{64}$/;

function tokenPath(home: string): string {
  return join(home, 'token');
}

/** The current token, or null when there is none (or it is unreadable). Read on every hello. */
export function readToken(home: string): string | null {
  try {
    const value = readFileSync(tokenPath(home), 'utf8').trim();
    return TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeNewToken(home: string): string {
  ensureHome(home);
  const token = randomBytes(32).toString('hex');
  const tmp = `${tokenPath(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, tokenPath(home));
  return token;
}

/** Returns the machine's token, creating it when missing or unreadable. */
export function loadToken(home: string): string {
  ensureHome(home);
  return readToken(home) ?? writeNewToken(home);
}

export function rotateToken(home: string): string {
  return writeNewToken(home);
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
