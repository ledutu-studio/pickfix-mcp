import { z } from 'zod';
import { BATCH_SCHEMA, ID_PATTERN, LIMITS, MAX_FLOW_STEPS, MAX_ITEMS_PER_BATCH } from './constants.js';

export const idSchema = z.string().regex(ID_PATTERN);
const timestamp = z.string().min(1).max(64);
const base64 = z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const pageRefSchema = z.object({
  url: z.string().max(4096),
  path: z.string().max(2048),
  title: z.string().max(1000),
});

export const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  dpr: z.number().positive(),
});

export const sourceHintSchema = z.object({
  framework: z.enum(['react', 'vue', 'svelte', 'angular', 'unknown']),
  file: z.string().max(1024).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional(),
  component: z.string().max(200).optional(),
  componentChain: z.array(z.string().max(200)).max(LIMITS.componentChain).optional(),
  confidence: z.enum(['exact', 'file', 'component', 'none']),
  via: z.enum(['attribute', 'react-fiber', 'react-debug-stack', 'vue', 'svelte', 'angular', 'fallback']),
});

export const anchorSchema = z.object({
  selector: z.string().max(2000),
  tag: z.string().max(100),
  text: z.string().max(LIMITS.anchorText),
  html: z.string().max(LIMITS.anchorHtml),
  rect: rectSchema,
  attributes: z.record(z.string().max(100), z.string().max(1000)),
  styles: z.record(z.string().max(100), z.string().max(500)).optional(),
  source: sourceHintSchema,
});

export const screenshotSchema = z.object({
  mime: z.enum(['image/png', 'image/jpeg']),
  data: base64,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  region: z.enum(['element', 'viewport']),
  clipped: z.boolean(),
});

export const flowActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), anchor: anchorSchema }),
  z.object({ type: z.literal('input'), anchor: anchorSchema, value: z.string().max(5000), masked: z.boolean() }),
  z.object({ type: z.literal('select'), anchor: anchorSchema, value: z.string().max(1000), label: z.string().max(1000) }),
  z.object({ type: z.literal('check'), anchor: anchorSchema, checked: z.boolean() }),
  z.object({ type: z.literal('key'), anchor: anchorSchema.optional(), key: z.enum(['Enter', 'Escape', 'Tab']) }),
  z.object({ type: z.literal('navigate'), url: z.string().max(4096), cause: z.enum(['route', 'load', 'reload', 'history']) }),
  z.object({ type: z.literal('note'), text: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal('console'),
    level: z.enum(['error', 'exception', 'rejection']),
    message: z.string().max(2000),
    stack: z.string().max(4000).optional(),
    count: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('network'),
    method: z.string().max(20),
    url: z.string().max(4096),
    status: z.number().int().nullable(),
    error: z.string().max(500).optional(),
    count: z.number().int().positive(),
  }),
]);

export const flowStepSchema = z.intersection(
  z.object({ id: idSchema, at: timestamp, path: z.string().max(2048) }),
  flowActionSchema,
);

export const flowSchema = z.object({
  expected: z.string().max(4000),
  actual: z.string().max(4000),
  failedStepId: idSchema.optional(),
  startedAt: timestamp,
  endedAt: timestamp,
  steps: z.array(flowStepSchema).max(MAX_FLOW_STEPS),
});

export const itemSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['element', 'text-edit', 'page', 'flow']),
    comment: z.string().trim().min(1).max(4000),
    page: pageRefSchema,
    anchor: anchorSchema.optional(),
    textEdit: z.object({ before: z.string().max(4000), after: z.string().max(4000) }).optional(),
    flow: flowSchema.optional(),
    screenshot: screenshotSchema.optional(),
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
  });

export const batchSchema = z
  .object({
    schema: z.literal(BATCH_SCHEMA),
    id: idSchema,
    createdAt: timestamp,
    page: pageRefSchema,
    viewport: viewportSchema,
    client: z.object({ extensionVersion: z.string().max(50), userAgent: z.string().max(500) }),
    items: z.array(itemSchema).min(1).max(MAX_ITEMS_PER_BATCH),
  })
  .superRefine((batch, ctx) => {
    const seen = new Set<string>();
    for (const [i, item] of batch.items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({ code: 'custom', path: ['items', i, 'id'], message: `Duplicate item id "${item.id}".` });
      }
      seen.add(item.id);
    }
  });

export const batchStatusSchema = z.enum(['queued', 'working', 'done', 'partial', 'failed', 'cancelled']);
export const itemOutcomeSchema = z.enum(['done', 'skipped', 'failed']);

export const batchReportSchema = z.object({
  outcome: z.enum(['done', 'partial', 'failed']),
  summary: z.string().trim().min(1).max(LIMITS.summary),
  changedFiles: z.array(z.string().max(1024)).max(200),
  items: z.array(
    z.object({ itemId: idSchema, outcome: itemOutcomeSchema, note: z.string().max(LIMITS.itemNote).optional() }),
  ),
});

export const sessionSchema = z.object({
  sessionId: z.string().min(1).max(100),
  name: z.string().max(200),
  cwd: z.string().max(4096),
  startedAt: timestamp,
  agent: z.string().max(100),
  pid: z.number().int().positive(),
});

export type Rect = z.infer<typeof rectSchema>;
export type PageRef = z.infer<typeof pageRefSchema>;
export type Viewport = z.infer<typeof viewportSchema>;
export type SourceHint = z.infer<typeof sourceHintSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type Screenshot = z.infer<typeof screenshotSchema>;
export type FlowAction = z.infer<typeof flowActionSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type Item = z.infer<typeof itemSchema>;
export type ItemKind = Item['kind'];
export type Batch = z.infer<typeof batchSchema>;
export type BatchStatus = z.infer<typeof batchStatusSchema>;
export type ItemOutcome = z.infer<typeof itemOutcomeSchema>;
export type BatchReport = z.infer<typeof batchReportSchema>;
export type Session = z.infer<typeof sessionSchema>;
