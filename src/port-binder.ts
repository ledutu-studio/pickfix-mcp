import type { Server } from 'node:http';

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
