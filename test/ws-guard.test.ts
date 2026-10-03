import { describe, expect, it } from 'vitest';
import { EXTENSION_ID } from '@pickfix/protocol';
import { WindowCounter, allowedOrigins, checkUpgrade } from '../src/ws-guard.js';

const origins = allowedOrigins({ PICKFIX_EXTENSION_IDS: 'devid1, devid2' });
const req = (headers: Record<string, string>, url = '/pickfix') => ({ url, headers });

describe('allowedOrigins', () => {
  it('always allows the published extension and adds development ids', () => {
    expect([...origins].sort()).toEqual(
      [`chrome-extension://${EXTENSION_ID}`, 'chrome-extension://devid1', 'chrome-extension://devid2'].sort(),
    );
  });
});

describe('checkUpgrade', () => {
  const good = { host: '127.0.0.1:47400', origin: `chrome-extension://${EXTENSION_ID}` };

  it('accepts the extension on a loopback host', () => {
    expect(checkUpgrade(req(good), 47400, origins)).toEqual({ ok: true });
    expect(checkUpgrade(req({ ...good, host: 'localhost:47400' }), 47400, origins)).toEqual({ ok: true });
  });

  it('refuses other paths with 404', () => {
    expect(checkUpgrade(req(good, '/other'), 47400, origins)).toMatchObject({ ok: false, status: 404 });
  });

  it.each([
    ['a web page origin', { ...good, origin: 'http://evil.test' }],
    ['no origin', { host: good.host }],
    ['another extension', { ...good, origin: 'chrome-extension://someoneelse' }],
    ['a rebinding host', { ...good, host: 'evil.test:47400' }],
    ['another port', { ...good, host: '127.0.0.1:47401' }],
  ])('refuses %s with 403', (_label, headers) => {
    expect(checkUpgrade(req(headers as Record<string, string>), 47400, origins)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('WindowCounter', () => {
  it('counts events inside a sliding window', () => {
    let t = 0;
    const counter = new WindowCounter(2, 1000, () => t);
    counter.record();
    expect(counter.exceeded()).toBe(false);
    counter.record();
    expect(counter.exceeded()).toBe(true);
    t = 1001;
    expect(counter.exceeded()).toBe(false);
  });
});
