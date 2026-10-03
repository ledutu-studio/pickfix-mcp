import { describe, expect, it } from 'vitest';
import { ID_PATTERN, LIMITS, MAX_MESSAGE_BYTES, PORTS, PORT_FIRST, PORT_LAST, WS_PATH } from '../src/index.js';

describe('constants', () => {
  it('lists ten loopback ports from 47400', () => {
    expect(PORT_FIRST).toBe(47400);
    expect(PORT_LAST).toBe(47409);
    expect(PORTS).toEqual([47400, 47401, 47402, 47403, 47404, 47405, 47406, 47407, 47408, 47409]);
  });

  it('fixes the path and limits', () => {
    expect(WS_PATH).toBe('/pickfix');
    expect(MAX_MESSAGE_BYTES).toBe(15 * 1024 * 1024);
    expect(LIMITS.summary).toBe(600);
  });

  it('accepts uuids and rejects path-like ids', () => {
    expect(ID_PATTERN.test('3f9c2b1e-6a2d-4f7a-9c1e-0b5d2a7e4c11')).toBe(true);
    expect(ID_PATTERN.test('item_1')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(101), 'é']) {
      expect(ID_PATTERN.test(bad)).toBe(false);
    }
  });
});
