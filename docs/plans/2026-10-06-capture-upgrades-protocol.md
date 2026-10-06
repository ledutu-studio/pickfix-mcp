# Capture Upgrades — Protocol 3 and pickfix-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship protocol 3 (`@pickfix/protocol`) with region items, reference-image attachments, per-item viewport and comment-optional items, and teach `pickfix-mcp` to store, render, claim and import them.

**Architecture:** The protocol package gains additive schemas (`attachmentSchema`, `regionSchema`, new item fields) plus a stricter version (`PROTOCOL_VERSION` 3, `pickfix.batch/2`). The markdown renderer labels current-state screenshots and reference images separately and renders regions. The queue store writes attachments to disk next to screenshots; the claim tool attaches images in item order (screenshot, then references) under the existing 8-image and character budget; `pickfix_import` refuses `/1` exports.

**Tech Stack:** TypeScript 7 (NodeNext), zod 4, vitest 5, `@modelcontextprotocol/sdk` 1.31, esbuild bundle in `plugin/dist`, pnpm workspace.

**Spec:** `/Users/tungle/ledutu/frontend-quickfix/pickfix-extension/docs/specs/2026-10-06-capture-upgrades-design.md` — this plan covers §3 (protocol) and §9 (pickfix-mcp), with their tests from §10/§11. The extension work (§4–§8) is a separate plan in `pickfix-extension`.

## Global Constraints

- Work in `/Users/tungle/ledutu/frontend-quickfix/pickfix-mcp`. Before running anything: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"`.
- `PROTOCOL_VERSION = 3`; `BATCH_SCHEMA = 'pickfix.batch/2'`; `MAX_ATTACHMENTS_PER_ITEM = 3`; `MAX_REGION_ANCHORS = 5`. Strict version match as today; no compatibility layer ("there are no users yet").
- `pickfix_import` accepts only `pickfix.batch/2`; a `/1` file gets "This file was exported by an older Pickfix. Export it again with the current extension."
- Attachment files on disk: `<batchDir>/<itemId>-ref-<n>.<png|jpg>` with `n` starting at 1, mode `0o600`, like screenshots.
- Claim images: in item order — the item's screenshot, then its reference images — while `MAX_IMAGES_PER_CLAIM` (8) and the character budget allow. Labels: `attached as image k (also at <path>)` or `not attached (too many images); read it from <path>`.
- Everything Claude reads (markdown, tool descriptions, errors, skill, prompt, server instructions) is English.
- `plugin/dist/*.mjs` is committed and a test (`test/bundle.test.ts`) checks it is fresh: every task that changes `src/` or `packages/protocol/src/` runs `pnpm build` and commits `plugin/dist` with the change.
- `plugin/skills/fix/SKILL.md` body must equal `FIX_BODY` in `src/prompts.ts` byte for byte (`test/plugin.test.ts`).
- `packages/protocol/dist` is git-ignored; the extension consumes it through `link:`, so the last task runs `pnpm --filter @pickfix/protocol build`.
- Do not commit unrelated files. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A whitespace-only comment with images** — the reviewer typed spaces and pasted an image; the item must be accepted (trim, then the image rule) and rendered with the no-description sentence, not an empty quote. Test added in Task 1 and Task 2.
2. **A region with zero anchors** — nothing lies fully inside the box; the batch must validate, render a clear "No element lies fully inside the region" line, and the oversized index must not crash on `region.anchors[0]`. Tests in Task 2 and Task 4.
3. **An attachment file missing on disk** (pruned or hand-deleted) — claim must not throw or push an empty image; the label falls back to "included in the batch file". Test in Task 4.
4. **More images than the claim budget** — three items × (1 screenshot + 3 references) = 12 images; exactly 8 attached in item order and the rest labelled with their path. Test in Task 4.
5. **A `/1` export handed to `pickfix_import`** — must get the "older Pickfix" message, not a zod dump. Test in Task 4.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/protocol/src/constants.ts` | Version, schema tag, limits | Modify |
| `packages/protocol/src/schemas.ts` | zod schemas and types | Modify: `attachmentSchema`, `regionSchema`, item fields, rules |
| `packages/protocol/src/markdown.ts` | Batch → markdown for Claude | Modify: labels, region, image-only, viewport |
| `packages/protocol/package.json` | Package version | 0.2.0 → 0.3.0 |
| `packages/protocol/test/fixtures.ts` | Shared test data | Modify: `/2` tag, `makeRegionItem`, `makeAttachment` |
| `packages/protocol/test/{constants,schemas,markdown}.test.ts` | Protocol tests | Modify |
| `src/queue-store.ts` | Batch storage on disk | Modify: attachments as files, path/base64 helpers |
| `src/tools.ts` | MCP tools | Modify: claim image ordering, index line, import `/1` refusal, claim description |
| `src/prompts.ts`, `plugin/skills/fix/SKILL.md` | Instructions for Claude | Modify: reference images, regions, image-only items |
| `test/{bridge,queue-store,tools}.test.ts`, `test/e2e/server.e2e.test.ts` | Server tests | Modify |
| `README.md`, `PRIVACY.md` | Docs | Modify |
| `plugin/dist/server.mjs`, `plugin/dist/hook.mjs` | Committed bundle | Rebuilt |

---

### Task 1: Protocol 3 schemas and constants

**Files:**
- Modify: `packages/protocol/src/constants.ts:1,15`
- Modify: `packages/protocol/src/schemas.ts:49-56,94-118,160-178`
- Modify: `packages/protocol/package.json:3`
- Modify: `packages/protocol/test/fixtures.ts`
- Test: `packages/protocol/test/constants.test.ts`, `packages/protocol/test/schemas.test.ts`, `test/bridge.test.ts`, `test/e2e/server.e2e.test.ts`
- Rebuild: `plugin/dist/*`

**Interfaces:**
- Consumes: nothing new.
- Produces (exported from `@pickfix/protocol`):
  - `PROTOCOL_VERSION = 3`, `BATCH_SCHEMA = 'pickfix.batch/2'`, `MAX_ATTACHMENTS_PER_ITEM = 3`, `MAX_REGION_ANCHORS = 5`
  - `attachmentSchema` → `type Attachment = { mime: 'image/png' | 'image/jpeg'; data: string; width: number; height: number; name?: string }`
  - `regionSchema` → `type Region = { rect: Rect; anchors: Anchor[] }`
  - `screenshotSchema.region: 'element' | 'viewport' | 'area'`
  - `Item` gains `kind: … | 'region'`, `comment` may be `''`, `region?: Region`, `attachments?: Attachment[]`, `viewport?: Viewport`
  - fixtures: `makeAttachment(name?: string): Attachment`, `makeRegionItem(id?: string): Item`

- [ ] **Step 1: Write the failing tests**

Replace `packages/protocol/test/constants.test.ts` imports and add a test:

```ts
import { describe, expect, it } from 'vitest';
import {
  BATCH_SCHEMA,
  ID_PATTERN,
  LIMITS,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_MESSAGE_BYTES,
  MAX_REGION_ANCHORS,
  PORTS,
  PORT_FIRST,
  PORT_LAST,
  PROTOCOL_VERSION,
  WS_PATH,
} from '../src/index.js';
```

and inside `describe('constants', …)`:

```ts
  it('speaks protocol 3 and batch schema 2 with the capture limits', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(BATCH_SCHEMA).toBe('pickfix.batch/2');
    expect(MAX_ATTACHMENTS_PER_ITEM).toBe(3);
    expect(MAX_REGION_ANCHORS).toBe(5);
  });
```

Update `packages/protocol/test/fixtures.ts` to the new shape (the tests below use it):

```ts
import { BATCH_SCHEMA, type Attachment, type Batch, type Item } from '../src/index.js';

/** A valid 1×1 transparent PNG. */
export const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function makeAttachment(name = 'figma.png'): Attachment {
  return { mime: 'image/png', data: PNG_1PX, width: 1, height: 1, name };
}
```

keep `makeElementItem` unchanged, then add after it:

```ts
export function makeRegionItem(id = 'region-1'): Item {
  const element = makeElementItem();
  return {
    id,
    kind: 'region',
    comment: 'Tighten the spacing between these cards.',
    page: element.page,
    viewport: { width: 1280, height: 800, dpr: 2 },
    region: { rect: { x: 40, y: 120, width: 600, height: 320 }, anchors: [element.anchor!] },
    screenshot: { mime: 'image/png', data: PNG_1PX, width: 1, height: 1, region: 'area', clipped: false },
    createdAt: '2026-10-02T10:00:30.000Z',
  };
}
```

and in `makeBatch` replace `schema: 'pickfix.batch/1',` with `schema: BATCH_SCHEMA,`.

In `packages/protocol/test/schemas.test.ts`, change the import to:

```ts
import { batchReportSchema, batchSchema, flowStepSchema, itemSchema } from '../src/index.js';
import { makeAttachment, makeBatch, makeElementItem, makeRegionItem } from './fixtures.js';
```

replace the test `'refuses a wrong schema tag'` with:

```ts
  it('refuses a wrong schema tag, including the protocol 2 tag', () => {
    expect(batchSchema.safeParse({ ...makeBatch(), schema: 'pickfix.batch/1' }).success).toBe(false);
    expect(batchSchema.safeParse({ ...makeBatch(), schema: 'pickfix.batch/3' }).success).toBe(false);
  });
```

replace the test `'refuses an empty comment'` with:

```ts
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
```

In `test/bridge.test.ts`, change line 3 to

```ts
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, type Session } from '@pickfix/protocol';
```

line 13 to

```ts
const hello = () => ({ v: 1, type: 'hello', protocol: PROTOCOL_VERSION, client: { extensionVersion: '0.1.0', browser: 'test' } });
```

in `authed()` change `protocol: 2` to `protocol: PROTOCOL_VERSION`, and add after the test `'tells a protocol 1 extension (which still sends a pairing token) to update'`:

```ts
  it('tells a protocol 2 extension to update, naming protocol 3', async () => {
    const client = await connect(bridge.port);
    await client.next();
    client.send({ ...hello(), protocol: 2 });
    const reply = await client.next();
    expect(reply).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
    expect(JSON.stringify(reply)).toContain('protocol 3');
    expect(await client.closed).toBe(1008);
  });
```

In `test/e2e/server.e2e.test.ts` (`connectedExtension`), change `protocol: 2` to `protocol: 3` in both the `server.info` expectation and the `hello` it sends.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/protocol/test test/bridge.test.ts`
Expected: FAIL — `PROTOCOL_VERSION` is 2, `MAX_ATTACHMENTS_PER_ITEM`/`makeAttachment` undefined, region and attachment tests fail.

- [ ] **Step 3: Implement**

`packages/protocol/src/constants.ts`: change line 1 to `export const PROTOCOL_VERSION = 3;` and replace the `BATCH_SCHEMA` line with:

```ts
export const BATCH_SCHEMA = 'pickfix.batch/2';
/** Reference images the reviewer may attach to one item. */
export const MAX_ATTACHMENTS_PER_ITEM = 3;
/** Elements recorded for a dragged region: the largest ones fully inside it. */
export const MAX_REGION_ANCHORS = 5;
```

`packages/protocol/src/schemas.ts`: change the import line to

```ts
import {
  BATCH_SCHEMA,
  ID_PATTERN,
  LIMITS,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_FLOW_STEPS,
  MAX_ITEMS_PER_BATCH,
  MAX_REGION_ANCHORS,
} from './constants.js';
```

replace `screenshotSchema` and add the two new schemas right after it:

```ts
export const screenshotSchema = z.object({
  mime: z.enum(['image/png', 'image/jpeg']),
  data: base64,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** element: the element plus a margin; viewport: the visible page; area: exactly the dragged region. */
  region: z.enum(['element', 'viewport', 'area']),
  clipped: z.boolean(),
});

/** A reference image the reviewer attached: the look they want, not the page's current state. */
export const attachmentSchema = z.object({
  mime: z.enum(['image/png', 'image/jpeg']),
  data: base64,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The original file name, shown in exports. */
  name: z.string().max(200).optional(),
});

/** A box the reviewer dragged over the page, in viewport CSS pixels, and the largest elements fully inside it. */
export const regionSchema = z.object({
  rect: rectSchema,
  anchors: z.array(anchorSchema).max(MAX_REGION_ANCHORS),
});
```

replace `itemSchema` with:

```ts
export const itemSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['element', 'text-edit', 'page', 'flow', 'region']),
    /** May be empty when the item carries at least one reference image. */
    comment: z.string().trim().max(4000),
    page: pageRefSchema,
    /** The viewport when the item was captured; the batch viewport is the one at send time. */
    viewport: viewportSchema.optional(),
    anchor: anchorSchema.optional(),
    textEdit: z.object({ before: z.string().max(4000), after: z.string().max(4000) }).optional(),
    flow: flowSchema.optional(),
    region: regionSchema.optional(),
    screenshot: screenshotSchema.optional(),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_ITEM).optional(),
    createdAt: timestamp,
  })
  .superRefine((item, ctx) => {
    if ((item.kind === 'element' || item.kind === 'text-edit') && !item.anchor) {
      ctx.addIssue({ code: 'custom', path: ['anchor'], message: `A ${item.kind} item needs an anchor.` });
    }
    if (item.kind === 'text-edit' && !item.textEdit) {
      ctx.addIssue({ code: 'custom', path: ['textEdit'], message: 'A text-edit item needs textEdit.' });
    }
    if (item.kind === 'flow' && !item.flow) {
      ctx.addIssue({ code: 'custom', path: ['flow'], message: 'A flow item needs flow.' });
    }
    if (item.kind === 'region' && !item.region) {
      ctx.addIssue({ code: 'custom', path: ['region'], message: 'A region item needs region.' });
    }
    if (item.comment.length === 0 && !item.attachments?.length) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'An item needs a comment or a reference image.' });
    }
  });
```

and add to the type exports at the bottom (next to `Screenshot`):

```ts
export type Attachment = z.infer<typeof attachmentSchema>;
export type Region = z.infer<typeof regionSchema>;
```

`packages/protocol/package.json`: `"version": "0.3.0"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/protocol/test test/bridge.test.ts`
Expected: PASS.
Then: `pnpm compile && pnpm test`
Expected: PASS except `test/tools.test.ts` and `test/bundle.test.ts` may fail only on things Tasks 2–4 change; if `test/bundle.test.ts` fails, continue to Step 5.

- [ ] **Step 5: Rebuild the bundle and run everything**

Run: `pnpm build && pnpm test && pnpm test:e2e`
Expected: PASS (the e2e already sends protocol 3).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/constants.ts packages/protocol/src/schemas.ts packages/protocol/package.json \
  packages/protocol/test/fixtures.ts packages/protocol/test/constants.test.ts packages/protocol/test/schemas.test.ts \
  test/bridge.test.ts test/e2e/server.e2e.test.ts plugin/dist
git commit -m "feat(protocol): protocol 3 with region items, reference images and per-item viewport

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Markdown for regions, reference images and image-only items

**Files:**
- Modify: `packages/protocol/src/markdown.ts`
- Test: `packages/protocol/test/markdown.test.ts`, `test/tools.test.ts:96` (heading text)
- Rebuild: `plugin/dist/*`

**Interfaces:**
- Consumes: `Item`, `Region`, `Attachment` from Task 1; fixtures `makeRegionItem`, `makeAttachment`.
- Produces:
  - `type RenderableItem = Omit<Item, 'screenshot' | 'attachments'> & { screenshot?: object; attachments?: object[] }`
  - `RenderOptions.attachmentLabel?(item: RenderableItem, itemIndex: number, attachmentIndex: number): string | undefined`
  - `export const NO_COMMENT_REQUEST = 'The reviewer wrote no description. Make the target match the attached reference image(s).'`
  - Headings `**Screenshot (current state):**` and `**Reference images (desired look, provided by the reviewer):**`; page-data lines `Viewport when captured: W×H @DPRx` and `Region: x,y W×H`.

- [ ] **Step 1: Write the failing tests**

In `packages/protocol/test/markdown.test.ts` change the imports to

```ts
import { NO_COMMENT_REQUEST, UNTRUSTED_NOTICE, fence, renderBatchMarkdown, type Item } from '../src/index.js';
import { makeAttachment, makeBatch, makeElementItem, makeRegionItem } from './fixtures.js';
```

replace the test `'uses the screenshot label when given'` with:

```ts
  it('labels the screenshot as the current state, with the label when given', () => {
    const md = renderBatchMarkdown(makeBatch(), { screenshotLabel: (_item, i) => `attached as image ${i + 1}` });
    expect(md).toContain('**Screenshot (current state):** attached as image 1');
  });

  it('lists reference images separately with their labels', () => {
    const item = { ...makeElementItem(), attachments: [makeAttachment('a.png'), makeAttachment('b.png')] };
    const md = renderBatchMarkdown(makeBatch({ items: [item] }), {
      attachmentLabel: (_item, itemIndex, n) => `attached as image ${itemIndex + n + 2}`,
    });
    expect(md).toContain(
      '**Reference images (desired look, provided by the reviewer):**\n1. attached as image 2\n2. attached as image 3',
    );
  });

  it('falls back to "included in the batch file" for reference images without a label', () => {
    const item = { ...makeElementItem(), attachments: [makeAttachment()] };
    expect(renderBatchMarkdown(makeBatch({ items: [item] }))).toContain(
      '**Reference images (desired look, provided by the reviewer):**\n1. included in the batch file',
    );
  });

  it('asks Claude to match the reference when the reviewer wrote nothing', () => {
    const item = { ...makeElementItem(), comment: '', attachments: [makeAttachment()] };
    const md = renderBatchMarkdown(makeBatch({ items: [item] }));
    expect(md).toContain(`**Reviewer's request:**\n${NO_COMMENT_REQUEST}`);
    expect(md).not.toMatch(/\*\*Reviewer's request:\*\*\n> \n/);
  });

  it('records the viewport each item was captured in', () => {
    const item = { ...makeElementItem(), viewport: { width: 390, height: 844, dpr: 3 } };
    expect(renderBatchMarkdown(makeBatch({ items: [item] }))).toContain('Viewport when captured: 390×844 @3x');
  });

  it('renders a region: its elements under "Where in the code" and the rectangle in the page data', () => {
    const md = renderBatchMarkdown(makeBatch({ items: [makeRegionItem()] }), {
      resolveSource: () => ({ path: 'src/components/CheckoutSummary.tsx', found: true }),
    });
    expect(md).toContain('## Item 1 of 1 · region · `region-1`');
    expect(md).toContain('- Element 1 in the region: <button>');
    expect(md).toContain('  - Source: `src/components/CheckoutSummary.tsx:88:7` (confidence: exact, via react-fiber)');
    const notice = md.indexOf(UNTRUSTED_NOTICE);
    expect(md.indexOf('Region: 40,120 600×320')).toBeGreaterThan(notice);
    expect(md).toContain('Region element 1: <button> main > section.summary > button.btn "Place order"');
  });

  it('says so when no element lies fully inside the region', () => {
    const item = makeRegionItem();
    const md = renderBatchMarkdown(makeBatch({ items: [{ ...item, region: { ...item.region!, anchors: [] } }] }));
    expect(md).toContain('- No element lies fully inside the region; use the screenshot and the route.');
  });
```

In `test/tools.test.ts`, in the test `'returns the markdown with the repo-relative source and the screenshot as an image'`, change

```ts
    expect(md).toContain('**Screenshot:** attached as image 1');
```

to

```ts
    expect(md).toContain('**Screenshot (current state):** attached as image 1 (also at');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/protocol/test/markdown.test.ts test/tools.test.ts`
Expected: FAIL — `NO_COMMENT_REQUEST` is not exported; headings and region lines missing.

- [ ] **Step 3: Implement**

In `packages/protocol/src/markdown.ts`:

Replace the `RenderableItem` and `RenderOptions` declarations with:

```ts
/** An item whose images may be stored elsewhere; only their presence matters here. */
export type RenderableItem = Omit<Item, 'screenshot' | 'attachments'> & { screenshot?: object; attachments?: object[] };
export type RenderableBatch = Omit<Batch, 'items'> & { items: RenderableItem[] };

export type RenderOptions = {
  /** Absolute repository root, shown in the header. */
  repoRoot?: string;
  /** Maps a page-reported source path to a repository path; `found: false` when the repo lacks it. */
  resolveSource?: (hint: SourceHint) => { path: string; found: boolean } | undefined;
  /** How the item's screenshot reaches the reader, e.g. "attached as image 1". */
  screenshotLabel?(item: RenderableItem, index: number): string | undefined;
  /** How one reference image reaches the reader, e.g. "attached as image 2". */
  attachmentLabel?(item: RenderableItem, itemIndex: number, attachmentIndex: number): string | undefined;
};

/** What Claude is asked to do when the reviewer attached images but wrote nothing. */
export const NO_COMMENT_REQUEST = 'The reviewer wrote no description. Make the target match the attached reference image(s).';
```

In `pageData`, after `const lines: string[] = [`Page title: ${item.page.title}`];` insert:

```ts
  if (item.viewport) lines.push(`Viewport when captured: ${item.viewport.width}×${item.viewport.height} @${item.viewport.dpr}x`);
  if (item.region) {
    const { x, y, width, height } = item.region.rect;
    lines.push(`Region: ${Math.round(x)},${Math.round(y)} ${Math.round(width)}×${Math.round(height)}`);
    item.region.anchors.forEach((anchor, i) => {
      const text = anchor.text ? ` "${anchor.text.slice(0, 80)}"` : '';
      lines.push(`Region element ${i + 1}: <${anchor.tag}> ${anchor.selector}${text}`);
    });
  }
```

Replace `renderItem` with:

```ts
function renderItem(item: RenderableItem, index: number, total: number, options: RenderOptions): string {
  const parts: string[] = [`## Item ${index + 1} of ${total} · ${item.kind} · \`${item.id}\``];
  const request = item.comment.trim() ? quote(item.comment) : NO_COMMENT_REQUEST;
  parts.push(`**${item.kind === 'flow' ? 'Workflow title' : "Reviewer's request"}:**\n${request}`);
  if (item.textEdit) parts.push(`**Requested text (after):**\n${quote(item.textEdit.after)}`);
  if (item.flow) {
    if (item.flow.expected) parts.push(`**Expected:**\n${quote(item.flow.expected)}`);
    if (item.flow.actual) parts.push(`**Actual:**\n${quote(item.flow.actual)}`);
  }
  const where: string[] = [`- Page: ${inline(item.page.url, 500)} (route ${inline(item.page.path, 300)})`];
  if (item.anchor) where.push(...sourceLines(item.anchor.source, options));
  if (item.region) {
    item.region.anchors.forEach((anchor, i) => {
      where.push(`- Element ${i + 1} in the region: <${inline(anchor.tag, 50)}>`);
      where.push(...sourceLines(anchor.source, options).map((line) => `  ${line}`));
    });
    if (item.region.anchors.length === 0) where.push('- No element lies fully inside the region; use the screenshot and the route.');
  }
  parts.push(`**Where in the code:**\n${where.join('\n')}`);
  if (item.screenshot) {
    const label = options.screenshotLabel?.(item, index) ?? 'included in the batch file';
    parts.push(`**Screenshot (current state):** ${label}`);
  }
  if (item.attachments?.length) {
    const labels = item.attachments.map((_, n) => `${n + 1}. ${options.attachmentLabel?.(item, index, n) ?? 'included in the batch file'}`);
    parts.push(`**Reference images (desired look, provided by the reviewer):**\n${labels.join('\n')}`);
  }
  parts.push(`${UNTRUSTED_NOTICE}\n\n${pageData(item)}`);
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/protocol/test/markdown.test.ts test/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Rebuild, run everything**

Run: `pnpm build && pnpm compile && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/markdown.ts packages/protocol/test/markdown.test.ts test/tools.test.ts plugin/dist
git commit -m "feat(protocol): render regions, reference images and image-only items for Claude

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Store reference images on disk

**Files:**
- Modify: `src/queue-store.ts:4,19-21,151-158,228-240`
- Test: `test/queue-store.test.ts`
- Rebuild: `plugin/dist/*`

**Interfaces:**
- Consumes: `Attachment`, `Item` from Task 1; fixtures `makeAttachment`, `makeRegionItem`.
- Produces:
  - `type StoredAttachment = Omit<Attachment, 'data'> & { file: string }`
  - `type StoredItem = Omit<Item, 'screenshot' | 'attachments'> & { screenshot?: StoredScreenshot; attachments?: StoredAttachment[] }`
  - `QueueStore.attachmentPath(batchId: string, attachment: StoredAttachment): string | undefined`
  - `QueueStore.attachmentBase64(batchId: string, attachment: StoredAttachment): string | undefined`

- [ ] **Step 1: Write the failing tests**

In `test/queue-store.test.ts` change the fixtures import to

```ts
import { makeAttachment, makeBatch, makeElementItem, makeRegionItem, PNG_1PX } from '../packages/protocol/test/fixtures.js';
```

and append:

```ts
describe('QueueStore reference images', () => {
  it('writes each attachment as <itemId>-ref-<n> and keeps only metadata in batch.json', () => {
    const { store } = newStore();
    const item = { ...makeElementItem(), attachments: [makeAttachment('a.png'), { ...makeAttachment('b.jpg'), mime: 'image/jpeg' as const }] };
    store.add(makeBatch({ items: [item] }), 's');
    const dir = join(store.dir, 'batch-1');
    expect(readFileSync(join(dir, 'item-1-ref-1.png')).toString('base64')).toBe(PNG_1PX);
    expect(existsSync(join(dir, 'item-1-ref-2.jpg'))).toBe(true);
    const stored = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8'));
    expect(stored.items[0].attachments).toEqual([
      { mime: 'image/png', width: 1, height: 1, name: 'a.png', file: 'item-1-ref-1.png' },
      { mime: 'image/jpeg', width: 1, height: 1, name: 'b.jpg', file: 'item-1-ref-2.jpg' },
    ]);
    expect(JSON.stringify(stored)).not.toContain(PNG_1PX);
  });

  it('returns base64 and a path for a stored attachment, and nothing when the file is gone', () => {
    const { store } = newStore();
    const { record } = store.add(makeBatch({ items: [{ ...makeElementItem(), attachments: [makeAttachment()] }] }), 's');
    const attachment = record.batch.items[0]!.attachments![0]!;
    expect(store.attachmentBase64('batch-1', attachment)).toBe(PNG_1PX);
    const path = store.attachmentPath('batch-1', attachment)!;
    rmSync(path);
    expect(store.attachmentPath('batch-1', attachment)).toBeUndefined();
    expect(store.attachmentBase64('batch-1', attachment)).toBeUndefined();
  });

  it('stores a region item with its area screenshot and no attachments key', () => {
    const { store } = newStore();
    const { record } = store.add(makeBatch({ items: [makeRegionItem()] }), 's');
    const stored = record.batch.items[0]!;
    expect(stored.screenshot).toMatchObject({ region: 'area', file: 'region-1.png' });
    expect(stored).not.toHaveProperty('attachments');
    expect(stored.region?.rect).toEqual({ x: 40, y: 120, width: 600, height: 320 });
  });
});
```

and add `rmSync` to the `node:fs` import at the top of the file:

```ts
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/queue-store.test.ts`
Expected: FAIL — no `item-1-ref-1.png`; `attachmentPath` is not a function.

- [ ] **Step 3: Implement**

In `src/queue-store.ts` change the protocol import to

```ts
import { ID_PATTERN, type Attachment, type Batch, type BatchReport, type BatchStatus, type Item, type Screenshot } from '@pickfix/protocol';
```

replace the stored types with

```ts
export type StoredScreenshot = Omit<Screenshot, 'data'> & { file: string };
export type StoredAttachment = Omit<Attachment, 'data'> & { file: string };
export type StoredItem = Omit<Item, 'screenshot' | 'attachments'> & { screenshot?: StoredScreenshot; attachments?: StoredAttachment[] };
export type StoredBatch = Omit<Batch, 'items'> & { items: StoredItem[] };
```

add above `export class QueueStore` (below `isProcessAlive`):

```ts
const extensionFor = (mime: string) => (mime === 'image/png' ? 'png' : 'jpg');

/** Writes an item's screenshot and reference images into `dir` and returns the item with file names instead of data. */
function storeImages(dir: string, item: Item): StoredItem {
  const { screenshot, attachments, ...rest } = item;
  const stored: StoredItem = rest;
  if (screenshot) {
    const { data, ...meta } = screenshot;
    const file = `${item.id}.${extensionFor(meta.mime)}`;
    writeFileSync(join(dir, file), Buffer.from(data, 'base64'), { mode: 0o600 });
    stored.screenshot = { ...meta, file };
  }
  if (attachments?.length) {
    stored.attachments = attachments.map(({ data, ...meta }, n) => {
      const file = `${item.id}-ref-${n + 1}.${extensionFor(meta.mime)}`;
      writeFileSync(join(dir, file), Buffer.from(data, 'base64'), { mode: 0o600 });
      return { ...meta, file };
    });
  }
  return stored;
}
```

in `add`, replace the `const items: StoredItem[] = batch.items.map((item) => { … });` block with

```ts
      const items: StoredItem[] = batch.items.map((item) => storeImages(tmp, item));
```

and add after `screenshotBase64`:

```ts
  attachmentPath(batchId: string, attachment: StoredAttachment): string | undefined {
    const path = join(this.batchDir(batchId), attachment.file);
    return existsSync(path) ? path : undefined;
  }

  attachmentBase64(batchId: string, attachment: StoredAttachment): string | undefined {
    const path = this.attachmentPath(batchId, attachment);
    return path ? readFileSync(path).toString('base64') : undefined;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/queue-store.test.ts`
Expected: PASS (the existing screenshot test still sees `item-1.png` and the same metadata).

- [ ] **Step 5: Rebuild, run everything**

Run: `pnpm build && pnpm compile && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/queue-store.ts test/queue-store.test.ts plugin/dist
git commit -m "feat(mcp): store reference images next to screenshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Claim attaches reference images; import refuses `/1`

**Files:**
- Modify: `src/tools.ts:37-77` (`claimMarkdown`), `:133` (claim description), `:200-215` (import)
- Test: `test/tools.test.ts`
- Rebuild: `plugin/dist/*`

**Interfaces:**
- Consumes: `QueueStore.attachmentPath/attachmentBase64`, `StoredItem.attachments` (Task 3); `RenderOptions.attachmentLabel` (Task 2); `MAX_IMAGES_PER_CLAIM = 8`.
- Produces: claim output order and labels per the Global Constraints; import error text "This file was exported by an older Pickfix. Export it again with the current extension."

- [ ] **Step 1: Write the failing tests**

In `test/tools.test.ts` change the fixtures import to

```ts
import { makeAttachment, makeBatch, makeElementItem, makeRegionItem, PNG_1PX } from '../packages/protocol/test/fixtures.js';
```

and add `rmSync` to the `node:fs` import:

```ts
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
```

Add inside `describe('pickfix_claim_batch', …)`:

```ts
  it('attaches the screenshot, then the reference images, each labelled', async () => {
    const item = { ...makeRegionItem('item-1'), attachments: [makeAttachment('a.png'), makeAttachment('b.png')] };
    deps.store.add(makeBatch({ items: [item] }), 's');
    const result = (await call('pickfix_claim_batch')) as { content: { type: string }[] };
    const md = text(result);
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(md).toMatch(/\*\*Screenshot \(current state\):\*\* attached as image 1 \(also at \S+item-1\.png\)/);
    expect(md).toMatch(/1\. attached as image 2 \(also at \S+item-1-ref-1\.png\)\n2\. attached as image 3 \(also at \S+item-1-ref-2\.png\)/);
  });

  it('attaches at most eight images in item order and points to the rest on disk', async () => {
    const items = [1, 2, 3].map((n) => ({
      ...makeElementItem(`item-${n}`),
      attachments: [makeAttachment('a.png'), makeAttachment('b.png'), makeAttachment('c.png')],
    }));
    deps.store.add(makeBatch({ items }), 's');
    const result = (await call('pickfix_claim_batch')) as { content: { type: string }[] };
    const md = text(result);
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(8);
    expect(md).toMatch(/3\. attached as image 8 \(also at \S+item-2-ref-3\.png\)/);
    expect(md).toMatch(/\*\*Screenshot \(current state\):\*\* not attached \(too many images\); read it from \S+item-3\.png/);
    expect(md).toMatch(/1\. not attached \(too many images\); read it from \S+item-3-ref-1\.png/);
  });

  it('skips a reference image whose file is gone without failing the claim', async () => {
    const { record } = deps.store.add(makeBatch({ items: [{ ...makeElementItem(), attachments: [makeAttachment()] }] }), 's');
    rmSync(deps.store.attachmentPath('batch-1', record.batch.items[0]!.attachments![0]!)!);
    const result = (await call('pickfix_claim_batch')) as { content: { type: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(text(result)).toContain('1. included in the batch file');
  });
```

Add inside `describe('pickfix_claim_batch size budget', …)`:

```ts
  it('names region and image-only items in the compact index, even a region with no elements', async () => {
    const batch = bigBatch();
    const region = makeRegionItem('item-1');
    batch.items[0] = { ...region, comment: '', attachments: [makeAttachment()], region: { ...region.region!, anchors: [] } };
    deps.store.add(batch, 's');
    const out = text(await call('pickfix_claim_batch'));
    expect(out).toContain('- Item 1 · region · item-1: (reference images only)');
  });
```

Add inside `describe('pickfix_import', …)`:

```ts
  it('tells the user to export again when the file comes from an older Pickfix', async () => {
    const file = join(deps.repoRoot, 'old.json');
    writeFileSync(file, JSON.stringify({ ...makeBatch({ id: 'old' }), schema: 'pickfix.batch/1' }));
    const result = (await call('pickfix_import', { path: file })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('This file was exported by an older Pickfix. Export it again with the current extension.');
    expect(deps.store.readState('old')).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/tools.test.ts`
Expected: FAIL — only the screenshot is attached; index line shows `region · item-1: ` with an empty request; import prints a zod error.

- [ ] **Step 3: Implement**

In `src/tools.ts`, change the protocol import to also bring in `BATCH_SCHEMA`:

```ts
import { BATCH_SCHEMA, LIMITS, batchReportSchema, batchSchema, renderBatchMarkdown, type BatchStatus, type Session } from '@pickfix/protocol';
```

Replace `claimMarkdown` with:

```ts
function claimMarkdown(deps: ToolDeps, record: BatchRecord): ToolResult {
  const { batch } = record;
  const resolveSource = (hint: { file?: string }) => (hint.file ? normalizeSourcePath(hint.file, deps.repoRoot) : undefined);
  const render = (shots: Map<string, string>, refs: Map<string, string>) =>
    renderBatchMarkdown(batch, {
      repoRoot: deps.repoRoot,
      resolveSource,
      screenshotLabel: (item) => shots.get(item.id),
      attachmentLabel: (item, _index, n) => refs.get(`${item.id}#${n}`),
    });

  const full = render(new Map(), new Map());
  const oversized = full.length > MAX_INLINE_CHARS;

  // Claude Code truncates tool output near 25,000 tokens: an oversized batch returns a compact index and a file.
  let compact = '';
  if (oversized) {
    const header = full.split('\n\n')[0];
    const lines = batch.items.map((item, i) => {
      const anchor = item.anchor ?? item.region?.anchors[0];
      const source = anchor?.source.file ? resolveSource(anchor.source) : undefined;
      const line = source && anchor?.source.line !== undefined ? `:${anchor.source.line}` : '';
      const where = source ? ` — ${compactLine(source.path, 200)}${line}` : '';
      const request = item.comment.trim() ? compactLine(item.comment, 200) : '(reference images only)';
      return `- Item ${i + 1} · ${item.kind} · ${item.id}: ${request}${where}`;
    });
    compact = `${header}\n\n${lines.join('\n')}`;
  }
  const textLength = oversized ? compact.length + 400 : full.length;

  // Images go in item order: the item's screenshot (current state), then its reference images (desired look).
  const images: Content[] = [];
  const attach = (path: string, read: () => string | undefined, mimeType: string): string => {
    const withinBudget = textLength + (images.length + 1) * IMAGE_COST_CHARS <= MAX_CLAIM_CHARS;
    const data = images.length < MAX_IMAGES_PER_CLAIM && withinBudget ? read() : undefined;
    if (data === undefined) return `not attached (too many images); read it from ${path}`;
    images.push({ type: 'image', data, mimeType });
    return `attached as image ${images.length} (also at ${path})`;
  };
  const shots = new Map<string, string>();
  const refs = new Map<string, string>();
  for (const item of batch.items) {
    const shotPath = deps.store.screenshotPath(batch.id, item);
    if (item.screenshot && shotPath) {
      shots.set(item.id, attach(shotPath, () => deps.store.screenshotBase64(batch.id, item), item.screenshot.mime));
    }
    item.attachments?.forEach((attachment, n) => {
      const path = deps.store.attachmentPath(batch.id, attachment);
      if (path) refs.set(`${item.id}#${n}`, attach(path, () => deps.store.attachmentBase64(batch.id, attachment), attachment.mime));
    });
  }

  const markdown = render(shots, refs);
  if (!oversized) return { content: [{ type: 'text', text: markdown }, ...images] };
  const filePath = deps.store.writeBatchMarkdown(batch.id, markdown);
  const text = `${compact}\n\nThe full batch with all page data is at ${filePath}. Read it before editing.`;
  return { content: [{ type: 'text', text }, ...images] };
}
```

Change the `pickfix_claim_batch` description to:

```ts
      description:
        'Claim a feedback batch before changing any code for it, and receive its items: the reviewer\'s requests, where each element or region lives in the code, screenshots of the current state and any reference images showing the desired look. Without batchId, claims the oldest queued batch. A batch can be claimed only once across all sessions.',
```

In `pickfix_import`, insert before `const parsed = batchSchema.safeParse(data);`:

```ts
      const schema = typeof data === 'object' && data !== null ? (data as { schema?: unknown }).schema : undefined;
      if (typeof schema === 'string' && schema.startsWith('pickfix.batch/') && schema !== BATCH_SCHEMA) {
        return error(`${file}: This file was exported by an older Pickfix. Export it again with the current extension.`);
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/tools.test.ts`
Expected: PASS, including the existing size-budget test (`≤ 8` images) and `'leaves a small batch unchanged'`.

- [ ] **Step 5: Rebuild, run everything**

Run: `pnpm build && pnpm compile && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts test/tools.test.ts plugin/dist
git commit -m "feat(mcp): attach reference images in claims and refuse older exports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Instructions, docs, end-to-end, protocol build

**Files:**
- Modify: `src/prompts.ts` (`SERVER_INSTRUCTIONS`, `FIX_BODY`), `plugin/skills/fix/SKILL.md`
- Modify: `README.md:71,90,97`, `PRIVACY.md:19-22,71-74`
- Test: `test/tools.test.ts` (prompt test), `test/plugin.test.ts` (unchanged, guards SKILL = FIX_BODY), `test/e2e/server.e2e.test.ts`
- Rebuild: `plugin/dist/*`, `packages/protocol/dist`

**Interfaces:**
- Consumes: everything above.
- Produces: the English instructions the extension's users rely on; a built `packages/protocol/dist` for the extension plan.

The skill text was originally drafted with `anthropic-skills:skill-creator` guidance; this task only extends it, keeping its voice. Keep `FIX_BODY` and the SKILL.md body identical.

- [ ] **Step 1: Write the failing tests**

In `test/tools.test.ts`, extend `'serves the fix prompt with the batch id filled in'`:

```ts
it('serves the fix prompt with the batch id filled in', async () => {
  const prompt = await mcp.client.getPrompt({ name: 'fix', arguments: { batchId: 'batch-9' } });
  const body = (prompt.messages[0]?.content as { text: string }).text;
  expect(body).toContain('pickfix_claim_batch');
  expect(body).toContain('"batch-9" names a batch id');
  expect(body).toContain('reference images show the look the reviewer wants');
  expect(body).toContain('For `region` items');
  expect(body).toContain('An item with no written request means: make the target match its reference image(s).');
});
```

In `test/e2e/server.e2e.test.ts` change the fixtures import to

```ts
import { makeAttachment, makeBatch, makeRegionItem } from '../../packages/protocol/test/fixtures.js';
```

and add inside `describe('pickfix-mcp end to end', …)`:

```ts
  it('carries a region item with reference images from the extension to the claim', async () => {
    const agent = await startAgent(tempHome(), realpathSync(tempDir()));
    const ext = await connectedExtension(agent);
    const item = { ...makeRegionItem('item-1'), comment: '', attachments: [makeAttachment('a.png'), makeAttachment('b.png')] };
    ext.send({ v: 1, type: 'batch.submit', requestId: 'r1', batch: makeBatch({ id: 'batch-r', items: [item] }) });
    expect(await ext.next()).toMatchObject({ type: 'batch.accepted', batchId: 'batch-r', status: 'queued' });
    const claim = (await agent.client.callTool({ name: 'pickfix_claim_batch', arguments: { batchId: 'batch-r' } })) as {
      content: { type: string }[];
    };
    const md = textOf(claim);
    expect(md).toContain('## Item 1 of 1 · region · `item-1`');
    expect(md).toContain('The reviewer wrote no description. Make the target match the attached reference image(s).');
    expect(md).toContain('**Reference images (desired look, provided by the reviewer):**');
    expect(claim.content.filter((c) => c.type === 'image')).toHaveLength(3);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/tools.test.ts -t "fix prompt"`
Expected: FAIL — the prompt has no reference-image text.

- [ ] **Step 3: Implement the instructions**

In `src/prompts.ts`, add a fifth rule to `SERVER_INSTRUCTIONS` (after rule 4, inside the template string):

```text
5. A screenshot shows the page's current state; reference images show the look the reviewer wants. When an item has reference images, match them with the project's own components and design tokens rather than copying pixels.
```

In `FIX_BODY`, replace step 2 with:

```text
2. Call \`pickfix_claim_batch\` so no other session works on the same batch. Read every item and look at every screenshot and reference image before editing: screenshots show the current state, reference images show the look the reviewer wants.
```

and in step 4, after the `flow` line, add:

```text
   For \`region\` items, the reviewer boxed an area of the page: change the layout or spacing of the elements in it together, not just one element. Its elements are listed under "Where in the code".
   An item with no written request means: make the target match its reference image(s).
```

Apply the same text (with plain backticks, no escaping) to `plugin/skills/fix/SKILL.md`, so its body equals `FIX_BODY`. Resulting SKILL.md step 2 and step 4:

```markdown
2. Call `pickfix_claim_batch` so no other session works on the same batch. Read every item and look at every screenshot and reference image before editing: screenshots show the current state, reference images show the look the reviewer wants.
```

```markdown
4. Make the smallest change that satisfies the reviewer's request. Follow the project's existing conventions (styling system, design tokens, component library).
   For `text-edit` items, change the copy to exactly the requested "after" text, including any i18n resource files that hold it.
   For `flow` items, walk through the steps, find the failing step, and fix the cause rather than the symptom.
   For `region` items, the reviewer boxed an area of the page: change the layout or spacing of the elements in it together, not just one element. Its elements are listed under "Where in the code".
   An item with no written request means: make the target match its reference image(s).
```

- [ ] **Step 4: Update the docs**

`README.md`:
- line 71: `| \`pickfix_claim_batch\` | Claims a batch and returns its items as markdown plus screenshots and reference images |`
- line 90: `  queue/<repo-key>/<batch>/ batch.json, state.json, screenshots, reference images`
- line 97: `The extension and server speak protocol 3 over WebSocket; the batch format is \`pickfix.batch/2\`. The original contract is section 5 of \`docs/specs/2026-10-02-pickfix-mcp-design.md\`; protocol 3's additions (regions, reference images, per-item viewport) are in the extension repo's \`docs/specs/2026-10-06-capture-upgrades-design.md\`. Types and schemas ship as \`@pickfix/protocol\` (\`packages/protocol\`).`

`PRIVACY.md` English table — add two rows after "Pick an element":

```markdown
| Drag over an area | Your comment; the area's position and size; the same details as above for up to five elements inside it; a screenshot of the area |
| Attach a reference image | The image you paste, drop or choose, stored with that feedback and sent with it |
```

Vietnamese table — add after "Chọn một phần tử":

```markdown
| Kéo chọn một vùng | Ghi chú của bạn; vị trí và kích thước vùng; các thông tin như trên cho tối đa năm phần tử nằm trong vùng; ảnh chụp vùng đó |
| Đính kèm ảnh mẫu | Ảnh bạn dán, kéo thả hoặc chọn, lưu cùng góp ý đó và gửi kèm theo |
```

- [ ] **Step 5: Rebuild and run everything**

Run:

```bash
pnpm build && pnpm compile && pnpm test && pnpm test:e2e
pnpm --filter @pickfix/protocol build
```

Expected: all PASS (`test/plugin.test.ts` confirms SKILL.md = `FIX_BODY`; `test/bundle.test.ts` confirms `plugin/dist` is fresh); `packages/protocol/dist/index.d.ts` now exports `attachmentSchema`, `regionSchema`, `MAX_ATTACHMENTS_PER_ITEM`, `NO_COMMENT_REQUEST`. Check: `grep -c "attachmentSchema\|NO_COMMENT_REQUEST" packages/protocol/dist/index.d.ts packages/protocol/dist/*.d.ts` prints a non-zero count.

- [ ] **Step 6: Commit**

```bash
git add src/prompts.ts plugin/skills/fix/SKILL.md README.md PRIVACY.md test/tools.test.ts test/e2e/server.e2e.test.ts plugin/dist
git commit -m "docs(mcp): teach Claude about regions and reference images; protocol 3 docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §3 constants/schemas → Task 1; §3.1 markdown → Task 2; §9 queue store → Task 3; §9 claim, index line, import → Task 4; §9 skill/prompt, README, PRIVACY → Task 5; §10 "server on protocol 2" → Task 1 bridge test; §11 mcp e2e → Task 5.
- The extension's own uses of `renderBatchMarkdown` (`lib/export.ts`) see the new `**Screenshot (current state):**` heading; the extension plan owns updating its tests.
