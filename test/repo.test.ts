import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoKey, resolveRepoRoot } from '../src/repo.js';
import { tempDir } from './helpers.js';

describe('resolveRepoRoot', () => {
  it('prefers the first file:// MCP root', () => {
    const a = tempDir();
    const b = tempDir();
    const root = resolveRepoRoot({ roots: ['https://example.com', pathToFileURL(a).href, pathToFileURL(b).href], env: {}, cwd: b });
    expect(root).toBe(realpathSync(a));
  });

  it('falls back to CLAUDE_PROJECT_DIR, then cwd', () => {
    const a = tempDir();
    const b = tempDir();
    expect(resolveRepoRoot({ env: { CLAUDE_PROJECT_DIR: a }, cwd: b })).toBe(realpathSync(a));
    expect(resolveRepoRoot({ env: {}, cwd: b })).toBe(realpathSync(b));
  });

  it('keeps a path that does not exist instead of throwing', () => {
    expect(resolveRepoRoot({ env: {}, cwd: '/definitely/not/here' })).toBe('/definitely/not/here');
  });
});

describe('repoKey', () => {
  it('is 16 hex characters and stable', () => {
    expect(repoKey('/Users/dev/shop')).toMatch(/^[0-9a-f]{16}$/);
    expect(repoKey('/Users/dev/shop')).toBe(repoKey('/Users/dev/shop'));
    expect(repoKey('/Users/dev/shop')).not.toBe(repoKey('/Users/dev/blog'));
  });
});

it('keeps nested directories distinct', () => {
  const base = tempDir();
  mkdirSync(join(base, 'web'));
  expect(repoKey(base)).not.toBe(repoKey(join(base, 'web')));
});
