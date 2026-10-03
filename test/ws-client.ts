import WebSocket from 'ws';
import { EXTENSION_ID, parseServerMessage, type ServerMessage } from '@pickfix/protocol';

export type TestClient = {
  ws: WebSocket;
  next(): Promise<ServerMessage>;
  send(message: unknown): void;
  sendRaw(text: string): void;
  closed: Promise<number>;
};

type Options = { origin?: string; host?: string; path?: string };

function open(port: number, options: Options): WebSocket {
  const headers: Record<string, string> = { Origin: options.origin ?? `chrome-extension://${EXTENSION_ID}` };
  if (options.host) headers.Host = options.host;
  return new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/pickfix'}`, { headers, maxPayload: 32 * 1024 * 1024 });
}

export function connect(port: number, options: Options = {}): Promise<TestClient> {
  const ws = open(port, options);
  const queue: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const parsed = parseServerMessage(data.toString());
    if (!parsed.ok) throw new Error(`Server sent an invalid message: ${parsed.error}`);
    const waiter = waiters.shift();
    if (waiter) waiter(parsed.message);
    else queue.push(parsed.message);
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () =>
      resolve({
        ws,
        closed,
        next: () =>
          new Promise<ServerMessage>((res, rej) => {
            const queued = queue.shift();
            if (queued) return res(queued);
            const timer = setTimeout(() => rej(new Error('No message within 3 s')), 3000);
            waiters.push((m) => {
              clearTimeout(timer);
              res(m);
            });
          }),
        send: (message) => ws.send(JSON.stringify(message)),
        sendRaw: (text) => ws.send(text),
      }),
    );
  });
}

/** The HTTP status of a refused upgrade. */
export function rejectedStatus(port: number, options: Options = {}): Promise<number> {
  const ws = open(port, options);
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => reject(new Error('The upgrade was accepted')));
    ws.once('error', () => {});
  });
}
