import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { options } from '../scripts/bundle.mjs';

it('the committed bundles match the sources (run `pnpm build` if this fails)', async () => {
  const result = await build({ ...options, write: false });
  expect(result.outputFiles.length).toBeGreaterThan(0);
  for (const file of result.outputFiles) {
    expect(readFileSync(file.path, 'utf8'), `${file.path} is stale`).toBe(file.text);
  }
}, 30_000);
