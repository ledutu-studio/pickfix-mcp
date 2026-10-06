import { UNTRUSTED_NOTICE } from './constants.js';
import type { Batch, FlowStep, Item, SourceHint } from './schemas.js';

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

/** Slices can split a surrogate pair; the model API rejects unpaired surrogates. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const COMPONENT_NAME = /^[A-Za-z0-9_$.:@<>-]{1,200}$/;

/** Sanitizes inline text from page data to prevent markdown injection. */
function inline(text: string, max: number): string {
  const controlCharPattern = new RegExp('[\u0000-\u001f\u007f  ]', 'g');
  return text
    .replace(controlCharPattern, ' ')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Fences text with more backticks than any run inside it, so the content cannot close the fence. */
export function fence(text: string, lang = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function sourceLines(hint: SourceHint, options: RenderOptions): string[] {
  const lines: string[] = [];
  if (hint.file) {
    const resolved = options.resolveSource?.(hint) ?? { path: hint.file, found: true };
    const sanitizedPath = inline(resolved.path, 300);
    const position = [sanitizedPath, hint.line, hint.column].filter((p) => p !== undefined).join(':');
    const tail = resolved.found ? '' : ' (reported by the page, not found in this repository)';
    lines.push(`- Source: \`${position}\` (confidence: ${hint.confidence}, via ${hint.via})${tail}`);
  } else {
    lines.push(`- Source: not located (confidence: ${hint.confidence}, via ${hint.via})`);
  }
  const chain = (hint.componentChain ?? (hint.component ? [hint.component] : [])).filter((n) => COMPONENT_NAME.test(n));
  if (chain.length > 0) lines.push(`- Component chain: ${chain.join(' ← ')}`);
  if (hint.framework !== 'unknown') lines.push(`- Framework: ${hint.framework}`);
  return lines;
}

function describeStep(step: FlowStep): string {
  const where = `[${step.path}]`;
  switch (step.type) {
    case 'click':
      return `${where} click <${step.anchor.tag}> "${step.anchor.text.slice(0, 80)}"`;
    case 'input':
      return `${where} type into <${step.anchor.tag}> ${step.masked ? '(masked value)' : `"${step.value.slice(0, 200)}"`}`;
    case 'select':
      return `${where} select "${step.label}" (${step.value}) in <${step.anchor.tag}>`;
    case 'check':
      return `${where} ${step.checked ? 'check' : 'uncheck'} <${step.anchor.tag}> "${step.anchor.text.slice(0, 80)}"`;
    case 'key':
      return `${where} press ${step.key}${step.anchor ? ` in <${step.anchor.tag}>` : ''}`;
    case 'navigate':
      return `${where} navigate (${step.cause}) to ${step.url}`;
    case 'note':
      return `${where} reviewer note: ${step.text}`;
    case 'console':
      return `${where} console ${step.level}${step.count > 1 ? ` ×${step.count}` : ''}: ${step.message}`;
    case 'network':
      return `${where} network ${step.method} ${step.url} → ${step.status ?? step.error ?? 'failed'}${step.count > 1 ? ` ×${step.count}` : ''}`;
  }
}

function pageData(item: RenderableItem): string {
  const lines: string[] = [`Page title: ${item.page.title}`];
  if (item.viewport) lines.push(`Viewport when captured: ${item.viewport.width}×${item.viewport.height} @${item.viewport.dpr}x`);
  if (item.region) {
    const { x, y, width, height } = item.region.rect;
    lines.push(`Region: ${Math.round(x)},${Math.round(y)} ${Math.round(width)}×${Math.round(height)}`);
    item.region.anchors.forEach((anchor, i) => {
      const text = anchor.text ? ` "${anchor.text.slice(0, 80)}"` : '';
      lines.push(`Region element ${i + 1}: <${anchor.tag}> ${anchor.selector}${text}`);
    });
  }
  const a = item.anchor;
  if (a) {
    lines.push(`Element: <${a.tag}>`, `Selector: ${a.selector}`);
    if (a.text) lines.push(`Text: ${a.text}`);
    const attributes = Object.entries(a.attributes);
    if (attributes.length > 0) lines.push(`Attributes: ${attributes.map(([k, v]) => `${k}="${v}"`).join(' ')}`);
    if (a.styles && Object.keys(a.styles).length > 0) {
      lines.push(`Key styles: ${Object.entries(a.styles).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    }
  }
  if (item.textEdit) lines.push(`Text before the edit: ${item.textEdit.before}`);
  if (item.flow) {
    lines.push('Steps:');
    item.flow.steps.forEach((step, i) => {
      const failing = step.id === item.flow?.failedStepId ? '  ← FAILING STEP' : '';
      lines.push(`${i + 1}. ${describeStep(step)}${failing}`);
    });
  }
  let out = fence(lines.join('\n'), 'text');
  if (a?.html) out += `\n\n${fence(a.html.slice(0, 2000), 'html')}`;
  return out;
}

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

export function renderBatchMarkdown(batch: RenderableBatch, options: RenderOptions = {}): string {
  const header = [
    `# Pickfix batch ${batch.id} — ${plural(batch.items.length, 'item')}`,
    '',
    `- Page: ${inline(batch.page.url, 500)}`,
    `- Route: ${inline(batch.page.path, 300)}`,
    `- Viewport: ${batch.viewport.width}×${batch.viewport.height} @${batch.viewport.dpr}x`,
    `- Sent: ${inline(batch.createdAt, 64)}`,
  ];
  if (options.repoRoot) header.push(`- Repository: ${options.repoRoot}`);
  const items = batch.items.map((item, i) => renderItem(item, i, batch.items.length, options));
  const footer = 'When you have finished, call pickfix_report with the outcome for each item.';
  return `${[header.join('\n'), ...items, footer].join('\n\n')}\n`.replace(LONE_SURROGATE, '\uFFFD');
}
