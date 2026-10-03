import { describe, expect, it } from 'vitest';
import { encodeMessage, parseClientMessage, parseServerMessage } from '../src/index.js';
import { makeBatch } from './fixtures.js';

describe('parseClientMessage', () => {
  it('parses hello', () => {
    const text = JSON.stringify({ v: 1, type: 'hello', protocol: 1, token: 'abc', client: { extensionVersion: '0.1.0', browser: 'Chrome 141' } });
    const result = parseClientMessage(text);
    expect(result.ok && result.message.type).toBe('hello');
  });

  it('parses batch.submit with a full batch', () => {
    const result = parseClientMessage(encodeMessage({ v: 1, type: 'batch.submit', requestId: 'r1', batch: makeBatch() }));
    expect(result.ok).toBe(true);
  });

  it('accepts only 6-digit pairing codes', () => {
    expect(parseClientMessage('{"v":1,"type":"pair","code":"123456"}').ok).toBe(true);
    expect(parseClientMessage('{"v":1,"type":"pair","code":"12345"}').ok).toBe(false);
  });

  it('reports invalid JSON', () => {
    expect(parseClientMessage('{nope')).toEqual({ ok: false, error: 'The message is not valid JSON.' });
  });

  it('refuses another protocol envelope version', () => {
    expect(parseClientMessage('{"v":2,"type":"ping"}').ok).toBe(false);
  });

  it('marks reserved rpc messages as ignorable', () => {
    const result = parseClientMessage('{"v":1,"type":"rpc.request","requestId":"x","method":"reload"}');
    expect(result).toMatchObject({ ok: false, ignore: true });
  });

  it('explains which field is wrong', () => {
    const result = parseClientMessage('{"v":1,"type":"batch.cancel","requestId":"r1"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('batchId');
  });
});

describe('parseServerMessage', () => {
  it('parses batch.status with a report', () => {
    const msg = {
      v: 1,
      type: 'batch.status',
      batchId: 'batch-1',
      status: 'done',
      report: { outcome: 'done', summary: 'Made the button full-width.', changedFiles: ['src/a.tsx'], items: [{ itemId: 'item-1', outcome: 'done' }] },
      updatedAt: '2026-10-02T10:05:00Z',
    } as const;
    expect(parseServerMessage(encodeMessage(msg))).toEqual({ ok: true, message: msg });
  });

  it('parses errors', () => {
    const result = parseServerMessage('{"v":1,"type":"error","code":"unauthorized","message":"Wrong token."}');
    expect(result.ok && result.message.type === 'error' && result.message.code).toBe('unauthorized');
  });
});
