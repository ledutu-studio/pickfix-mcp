import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXTENSION_ID, EXTENSION_PUBLIC_KEY } from '../src/index.js';

describe('extension identity', () => {
  it('derives the id from the public key the way Chrome does', () => {
    const hex = createHash('sha256').update(Buffer.from(EXTENSION_PUBLIC_KEY, 'base64')).digest('hex');
    const expected = [...hex.slice(0, 32)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
    expect(EXTENSION_ID).toBe(expected);
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });
});
