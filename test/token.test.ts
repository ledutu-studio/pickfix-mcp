import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadToken, readToken, rotateToken, tokensEqual } from '../src/token.js';
import { tempHome } from './helpers.js';

const mode = (path: string) => statSync(path).mode & 0o777;

describe('token', () => {
  it('creates a 64-hex token with private modes', () => {
    const home = tempHome();
    const token = loadToken(home);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, 'token'))).toBe(0o600);
  });

  it('returns the same token on the next load', () => {
    const home = tempHome();
    expect(loadToken(home)).toBe(loadToken(home));
  });

  it('replaces an unreadable token', () => {
    const home = tempHome();
    loadToken(home);
    writeFileSync(join(home, 'token'), 'garbage');
    expect(loadToken(home)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rotates to a different token that readToken then sees', () => {
    const home = tempHome();
    const first = loadToken(home);
    const second = rotateToken(home);
    expect(second).not.toBe(first);
    expect(readToken(home)).toBe(second);
  });

  it('readToken is null before any token exists', () => {
    expect(readToken(tempHome())).toBeNull();
  });

  it('compares tokens without throwing on different lengths', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
  });
});
