import type { Batch, Item } from '../src/index.js';

/** A valid 1×1 transparent PNG. */
export const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

export function makeBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    schema: 'pickfix.batch/1',
    id: 'batch-1',
    createdAt: '2026-10-02T10:01:00.000Z',
    page: { url: 'http://localhost:5173/checkout', path: '/checkout', title: 'Checkout' },
    viewport: { width: 1440, height: 900, dpr: 2 },
    client: { extensionVersion: '0.1.0', userAgent: 'Mozilla/5.0 Chrome/141' },
    items: [makeElementItem()],
    ...overrides,
  };
}
