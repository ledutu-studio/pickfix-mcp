import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeSourcePath } from '../src/source-paths.js';
import { tempDir } from './helpers.js';

let root = '';
beforeAll(() => {
  root = realpathSync(tempDir());
  mkdirSync(join(root, 'src/components'), { recursive: true });
  writeFileSync(join(root, 'src/components/Button.tsx'), '');
  writeFileSync(join(root, 'src/App.vue'), '');
});

describe('normalizeSourcePath', () => {
  it.each([
    ['absolute path inside the repo', () => join(root, 'src/components/Button.tsx')],
    ['relative path', () => 'src/components/Button.tsx'],
    ['./ relative path', () => './src/components/Button.tsx'],
    ['webpack namespace', () => 'webpack://shop/./src/components/Button.tsx'],
    ['webpack triple slash', () => 'webpack:///./src/components/Button.tsx'],
    ['next webpack-internal', () => 'webpack-internal:///(app-pages-browser)/./src/components/Button.tsx'],
    ['turbopack project', () => '[project]/src/components/Button.tsx'],
    ['turbopack source map url', () => 'turbopack:///[project]/src/components/Button.tsx'],
    ['vite /@fs', () => `/@fs${join(root, 'src/components/Button.tsx')}`],
    ['vite root-relative url path', () => '/src/components/Button.tsx?t=1712345'],
    ['file url', () => `file://${join(root, 'src/components/Button.tsx')}`],
    ['loader prefix', () => 'babel-loader!./src/components/Button.tsx'],
  ])('resolves a %s', (_label, raw) => {
    expect(normalizeSourcePath(raw(), root)).toEqual({ path: 'src/components/Button.tsx', found: true });
  });

  it('keeps vue files', () => {
    expect(normalizeSourcePath('/src/App.vue', root)).toEqual({ path: 'src/App.vue', found: true });
  });

  it.each(['/etc/passwd', '../../.ssh/id_rsa', 'webpack:///../secret.ts', 'src/../../outside.ts'])(
    'never resolves %s outside the repository',
    (raw) => {
      expect(normalizeSourcePath(raw, root).found).toBe(false);
    },
  );

  it('reports a missing file as not found with the cleaned path', () => {
    expect(normalizeSourcePath('webpack:///./src/Missing.tsx', root)).toEqual({ path: 'src/Missing.tsx', found: false });
  });
});
