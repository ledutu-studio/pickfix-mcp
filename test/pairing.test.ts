import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_PAIRING_ATTEMPTS, PAIRING_TTL_MS, createPairingCode, redeemPairingCode } from '../src/pairing.js';
import { tempHome } from './helpers.js';

describe('pairing codes', () => {
  it('creates a 6-digit code in a private file', () => {
    const home = tempHome();
    const { code, expiresAt } = createPairingCode(home, 1000);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBe(1000 + PAIRING_TTL_MS);
    expect(statSync(join(home, 'pairing.json')).mode & 0o777).toBe(0o600);
  });

  it('redeems the right code once', () => {
    const home = tempHome();
    const { code } = createPairingCode(home, 0);
    expect(redeemPairingCode(home, code, 10)).toBe('ok');
    expect(redeemPairingCode(home, code, 20)).toBe('none');
    expect(existsSync(join(home, 'pairing.json'))).toBe(false);
  });

  it('expires after two minutes', () => {
    const home = tempHome();
    const { code } = createPairingCode(home, 0);
    expect(redeemPairingCode(home, code, PAIRING_TTL_MS + 1)).toBe('expired');
  });

  it('invalidates the code after five wrong attempts', () => {
    const home = tempHome();
    const { code } = createPairingCode(home, 0);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) expect(redeemPairingCode(home, wrong, 1)).toBe('invalid');
    expect(redeemPairingCode(home, code, 2)).toBe('none');
  });

  it('a new code replaces the old one', () => {
    const home = tempHome();
    const first = createPairingCode(home, 0).code;
    const second = createPairingCode(home, 1).code;
    if (first !== second) expect(redeemPairingCode(home, first, 2)).toBe('invalid');
    expect(redeemPairingCode(home, second, 3)).toBe('ok');
  });
});
