#!/usr/bin/env node
/**
 * Bumps the version everywhere it is written, so the three stay in step (test/plugin.test.ts checks):
 * package.json, plugin/.claude-plugin/plugin.json and src/version.ts.
 *
 *   node scripts/bump-version.mjs patch|minor|major
 *
 * Prints the new version. Run `pnpm build` afterwards: plugin/dist embeds it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export const BUMPS = ['patch', 'minor', 'major'];

export const FILES = {
  'package.json': /("version":\s*")([^"]+)(")/,
  'plugin/.claude-plugin/plugin.json': /("version":\s*")([^"]+)(")/,
  'src/version.ts': /(SERVER_VERSION = ')([^']+)(')/,
};

export function nextVersion(version, bump) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`"${version}" is not a plain x.y.z version`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`bump must be one of ${BUMPS.join(', ')}, got "${bump}"`);
}

/** Replaces the first version in `text`; throws when the file carries none. */
export function withVersion(text, pattern, version) {
  if (!pattern.test(text)) throw new Error('no version found');
  return text.replace(pattern, `$1${version}$3`);
}

function main(bump) {
  const current = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
  const next = nextVersion(current, bump);
  for (const [path, pattern] of Object.entries(FILES)) {
    try {
      writeFileSync(`${root}${path}`, withVersion(readFileSync(`${root}${path}`, 'utf8'), pattern, next));
    } catch (error) {
      throw new Error(`${path}: ${error.message}`);
    }
  }
  console.log(next);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(`bump-version: ${error.message}`);
    process.exit(1);
  }
}
