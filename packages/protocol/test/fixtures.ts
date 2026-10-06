import { BATCH_SCHEMA, type Attachment, type Batch, type Item } from '../src/index.js';

/** A valid 1×1 transparent PNG. */
export const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function makeAttachment(name = 'figma.png'): Attachment {
  return { mime: 'image/png', data: PNG_1PX, width: 1, height: 1, name };
}

export function makeElementItem(id = 'item-1'): Item {
  return {
    id,
    kind: 'element',
    comment: 'Make the Place order button full-width on mobile.',
    page: { url: 'http://localhost:5173/checkout', path: '/checkout', title: 'Checkout' },
    anchor: {
      selector: 'main > section.summary > button.btn',
      tag: 'button',
      text: 'Place order',
      html: '<button class="btn btn-secondary">Place order</button>',
      rect: { x: 10, y: 20, width: 160, height: 40 },
      attributes: { class: 'btn btn-secondary' },
      styles: { width: '160px', 'background-color': 'rgb(229, 231, 235)' },
      source: {
        framework: 'react',
        file: '/Users/dev/shop/src/components/CheckoutSummary.tsx',
        line: 88,
        column: 7,
        component: 'Button',
        componentChain: ['Button', 'CheckoutSummary', 'CheckoutPage'],
        confidence: 'exact',
        via: 'react-fiber',
      },
    },
    screenshot: { mime: 'image/png', data: PNG_1PX, width: 1, height: 1, region: 'element', clipped: false },
    createdAt: '2026-10-02T10:00:00.000Z',
  };
}

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

export function makeBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    schema: BATCH_SCHEMA,
    id: 'batch-1',
    createdAt: '2026-10-02T10:01:00.000Z',
    page: { url: 'http://localhost:5173/checkout', path: '/checkout', title: 'Checkout' },
    viewport: { width: 1440, height: 900, dpr: 2 },
    client: { extensionVersion: '0.1.0', userAgent: 'Mozilla/5.0 Chrome/141' },
    items: [makeElementItem()],
    ...overrides,
  };
}
