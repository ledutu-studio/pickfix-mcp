import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function resolveRepoRoot(input: { roots?: string[]; env?: NodeJS.ProcessEnv; cwd?: string }): string {
  const fileRoot = input.roots?.find((uri) => uri.startsWith('file://'));
  if (fileRoot) return real(fileURLToPath(fileRoot));
  const projectDir = (input.env ?? process.env).CLAUDE_PROJECT_DIR;
  if (projectDir) return real(projectDir);
  return real(input.cwd ?? process.cwd());
}

export function repoKey(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}
