import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FILES, nextVersion, withVersion } from '../scripts/bump-version.mjs';

describe('nextVersion', () => {
  it('bumps patch, minor and major', () => {
    expect(nextVersion('1.1.0', 'patch')).toBe('1.1.1');
    expect(nextVersion('1.1.9', 'minor')).toBe('1.2.0');
    expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
  });

  it('refuses another bump or a version it cannot read', () => {
    expect(() => nextVersion('1.1.0', '99.0.0')).toThrow('bump must be one of patch, minor, major');
    expect(() => nextVersion('1.1.0-beta', 'patch')).toThrow('not a plain x.y.z version');
  });
});

describe('withVersion', () => {
  it('finds the version in every file that carries it', () => {
    for (const [path, pattern] of Object.entries(FILES)) {
      expect(withVersion(readFileSync(path, 'utf8'), pattern, '9.9.9'), path).toContain('9.9.9');
    }
  });

  it('changes only the first version in a file', () => {
    const text = '{ "version": "1.0.0", "deps": { "version": "3.0.0" } }';
    expect(withVersion(text, FILES['package.json']!, '1.0.1')).toBe('{ "version": "1.0.1", "deps": { "version": "3.0.0" } }');
  });

  it('throws when a file has no version', () => {
    expect(() => withVersion('{}', FILES['package.json']!, '1.0.1')).toThrow('no version found');
  });
});
