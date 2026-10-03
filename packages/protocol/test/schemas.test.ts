import { describe, expect, it } from 'vitest';
import { batchReportSchema, batchSchema, flowStepSchema, itemSchema } from '../src/index.js';
import { makeBatch, makeElementItem } from './fixtures.js';

describe('batchSchema', () => {
  it('accepts a valid batch', () => {
    expect(batchSchema.safeParse(makeBatch()).success).toBe(true);
  });

  it('drops unknown fields instead of failing', () => {
    const parsed = batchSchema.parse({ ...makeBatch(), extra: 'x', items: [{ ...makeElementItem(), extra: 1 }] });
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed.items[0]).not.toHaveProperty('extra');
  });

  it('refuses 0 and 51 items', () => {
    expect(batchSchema.safeParse(makeBatch({ items: [] })).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => makeElementItem(`item-${i}`));
    expect(batchSchema.safeParse(makeBatch({ items: many })).success).toBe(false);
  });

  it('refuses duplicate item ids', () => {
    expect(batchSchema.safeParse(makeBatch({ items: [makeElementItem('a'), makeElementItem('a')] })).success).toBe(false);
  });

  it('refuses ids that could escape a directory', () => {
    expect(batchSchema.safeParse(makeBatch({ id: '../evil' })).success).toBe(false);
  });

  it('refuses a wrong schema tag', () => {
    expect(batchSchema.safeParse({ ...makeBatch(), schema: 'pickfix.batch/2' }).success).toBe(false);
  });
});

describe('itemSchema', () => {
  it('requires an anchor for element items', () => {
    const { anchor: _anchor, ...noAnchor } = makeElementItem();
    expect(itemSchema.safeParse(noAnchor).success).toBe(false);
  });

  it('requires textEdit for text-edit items', () => {
    expect(itemSchema.safeParse({ ...makeElementItem(), kind: 'text-edit' }).success).toBe(false);
    expect(
      itemSchema.safeParse({ ...makeElementItem(), kind: 'text-edit', textEdit: { before: 'Buy', after: 'Buy now' } }).success,
    ).toBe(true);
  });

  it('requires flow for flow items', () => {
    const { anchor: _a, ...base } = makeElementItem();
    expect(itemSchema.safeParse({ ...base, kind: 'flow' }).success).toBe(false);
  });

  it('refuses an empty comment', () => {
    expect(itemSchema.safeParse({ ...makeElementItem(), comment: '  ' }).success).toBe(false);
  });

  it('refuses a screenshot that is not base64', () => {
    const item = makeElementItem();
    expect(itemSchema.safeParse({ ...item, screenshot: { ...item.screenshot, data: 'not base64!' } }).success).toBe(false);
  });
});

describe('flowStepSchema', () => {
  it('accepts a navigate step with its base fields', () => {
    const step = { id: 's1', at: '2026-10-02T10:00:00Z', path: '/', type: 'navigate', url: 'http://localhost:5173/', cause: 'load' };
    expect(flowStepSchema.parse(step)).toEqual(step);
  });

  it('refuses an unknown step type', () => {
    expect(flowStepSchema.safeParse({ id: 's1', at: 'x', path: '/', type: 'teleport' }).success).toBe(false);
  });
});

describe('batchReportSchema', () => {
  it('caps the summary at 600 characters', () => {
    const report = { outcome: 'done', summary: 'x'.repeat(601), changedFiles: [], items: [] };
    expect(batchReportSchema.safeParse(report).success).toBe(false);
  });
});
