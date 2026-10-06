import { describe, expect, it } from 'vitest';
import { batchReportSchema, batchSchema, flowStepSchema, itemSchema } from '../src/index.js';
import { makeAttachment, makeBatch, makeElementItem, makeRegionItem } from './fixtures.js';

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

  it('refuses a wrong schema tag, including the protocol 2 tag', () => {
    expect(batchSchema.safeParse({ ...makeBatch(), schema: 'pickfix.batch/1' }).success).toBe(false);
    expect(batchSchema.safeParse({ ...makeBatch(), schema: 'pickfix.batch/3' }).success).toBe(false);
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

  it('refuses an empty comment when there is no reference image', () => {
    expect(itemSchema.safeParse({ ...makeElementItem(), comment: '  ' }).success).toBe(false);
    const result = itemSchema.safeParse({ ...makeElementItem(), comment: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['comment'], message: 'An item needs a comment or a reference image.' });
  });

  it('accepts an item with reference images and no comment, trimming whitespace', () => {
    const parsed = itemSchema.parse({ ...makeElementItem(), comment: '   ', attachments: [makeAttachment()] });
    expect(parsed.comment).toBe('');
    expect(parsed.attachments).toHaveLength(1);
  });

  it('accepts up to three attachments and refuses a fourth', () => {
    const three = [makeAttachment('a.png'), makeAttachment('b.png'), makeAttachment('c.png')];
    expect(itemSchema.safeParse({ ...makeElementItem(), attachments: three }).success).toBe(true);
    expect(itemSchema.safeParse({ ...makeElementItem(), attachments: [...three, makeAttachment('d.png')] }).success).toBe(false);
  });

  it('refuses an attachment that is not a PNG or JPEG, not base64, or has a long name', () => {
    const base = makeElementItem();
    expect(itemSchema.safeParse({ ...base, attachments: [{ ...makeAttachment(), mime: 'image/webp' }] }).success).toBe(false);
    expect(itemSchema.safeParse({ ...base, attachments: [{ ...makeAttachment(), data: 'not base64!' }] }).success).toBe(false);
    expect(itemSchema.safeParse({ ...base, attachments: [makeAttachment('x'.repeat(201))] }).success).toBe(false);
  });

  it('accepts a region item with its rectangle, anchors and an area screenshot', () => {
    expect(itemSchema.safeParse(makeRegionItem()).success).toBe(true);
  });

  it('accepts a region with no anchors', () => {
    const item = makeRegionItem();
    expect(itemSchema.safeParse({ ...item, region: { ...item.region!, anchors: [] } }).success).toBe(true);
  });

  it('requires region for region items and caps its anchors at five', () => {
    const { region, ...noRegion } = makeRegionItem();
    const missing = itemSchema.safeParse(noRegion);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]).toMatchObject({ path: ['region'], message: 'A region item needs region.' });
    const six = Array.from({ length: 6 }, () => region!.anchors[0]!);
    expect(itemSchema.safeParse({ ...makeRegionItem(), region: { ...region!, anchors: six } }).success).toBe(false);
  });

  it('keeps the viewport an item was captured in', () => {
    const parsed = itemSchema.parse({ ...makeElementItem(), viewport: { width: 390, height: 844, dpr: 3 } });
    expect(parsed.viewport).toEqual({ width: 390, height: 844, dpr: 3 });
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
