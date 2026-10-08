import type { Server } from 'node:http';
import { PORTS } from '@pickfix/protocol';

/** The ports the bridge may take: `PICKFIX_PORT` alone when it is set (`fixed`), else the default range. */
export type PortChoice = { ports: readonly number[]; fixed: number | null };

export const MIN_FIXED_PORT = 1024;
export const MAX_FIXED_PORT = 65535;

/** Reads `PICKFIX_PORT`; throws when it is set to something that is not a port from 1024 to 65535. */
export function portChoice(env: NodeJS.ProcessEnv = process.env): PortChoice {
  const raw = env.PICKFIX_PORT?.trim();
  if (!raw) return { ports: PORTS, fixed: null };
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < MIN_FIXED_PORT || port > MAX_FIXED_PORT) {
    throw new Error(`PICKFIX_PORT must be a port number from ${MIN_FIXED_PORT} to ${MAX_FIXED_PORT}, not "${raw}".`);
  }
  return { ports: [port], fixed: port };
}

/** Binds a fresh server on the first port that is free; a failed server is discarded. */
export async function listenOnFirstFree(
  create: () => Server,
  ports: readonly number[],
  host = '127.0.0.1',
): Promise<{ server: Server; port: number } | null> {
  for (const port of ports) {
    const server = create();
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, host, () => resolve(true));
    });
    if (bound) return { server, port };
  }
  return null;
}
