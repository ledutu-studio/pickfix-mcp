import { pickfixHome } from './home.js';
import { hookOutput, queuedCount } from './hook-lib.js';
import { resolveRepoRoot } from './repo.js';

// Never block or fail the user's prompt: any problem means no output and exit code 0.
const deadline = setTimeout(() => process.exit(0), 1500);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const input = JSON.parse((await readStdin()) || '{}') as { cwd?: string };
  const root = resolveRepoRoot({ env: process.env, cwd: input.cwd });
  const output = hookOutput(queuedCount(pickfixHome(), root));
  if (output) process.stdout.write(output);
} catch {
  // Silent by design.
} finally {
  clearTimeout(deadline);
  process.exit(0);
}
