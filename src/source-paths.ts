import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIXES: RegExp[] = [
  /^turbopack:\/\/\/(\[project\]\/)?/,
  /^webpack-internal:\/\/\/(\([^)]*\)\/)?/,
  /^webpack:\/\/(?:\/|[^/]+\/)/,
  /^\[project\]\//,
  /^\/@fs(?=\/)/,
];

function clean(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('file://')) {
    try {
      path = fileURLToPath(path.split(/[?#]/)[0] ?? path);
    } catch {
      path = path.slice('file://'.length);
    }
  }
  path = path.split(/[?#]/)[0] ?? path;
  if (path.includes('!')) path = path.slice(path.lastIndexOf('!') + 1);
  for (const prefix of PREFIXES) path = path.replace(prefix, '');
  return path.replace(/\\/g, '/');
}

/** A repository-relative path, or null when `candidate` is outside `root`. */
function inside(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Maps a page-reported source path to a path inside the repository. Only paths inside
 * `repoRoot` are ever checked on disk; anything else is reported as not found.
 * `repoRoot` must already be realpath'd (resolveRepoRoot does this).
 */
export function normalizeSourcePath(raw: string, repoRoot: string): { path: string; found: boolean } {
  const cleaned = clean(raw);
  const candidates = isAbsolute(cleaned)
    ? [cleaned, resolve(repoRoot, `.${cleaned}`)]
    : [resolve(repoRoot, cleaned)];
  for (const candidate of candidates) {
    const rel = inside(repoRoot, candidate);
    if (rel && existsSync(candidate)) {
      try {
        const real = realpathSync(candidate);
        const realRel = inside(repoRoot, real);
        if (realRel) return { path: realRel, found: true };
      } catch {
        // Treat realpath failure as not found
      }
    }
  }
  const shown = isAbsolute(cleaned) ? (inside(repoRoot, cleaned) ?? cleaned) : cleaned.replace(/^\.\//, '');
  return { path: shown, found: false };
}
