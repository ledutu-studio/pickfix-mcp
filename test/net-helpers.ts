import { createServer } from 'node:net';

/** Ports that were free a moment ago, so tests never touch the real 47400–47409 range. */
export async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    ports.push(
      await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
        });
      }),
    );
  }
  return ports;
}
