import { createServer } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  APP_ID,
  MAX_MESSAGE_BYTES,
  PORTS,
  PROTOCOL_VERSION,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type Session,
} from '@pickfix/protocol';
import { log as defaultLog } from './log.js';
import { listenOnFirstFree } from './port-binder.js';
import type { BatchRecord, BatchState, QueueStore } from './queue-store.js';
import { WindowCounter, checkUpgrade } from './ws-guard.js';

export type BridgeDeps = {
  session: Session;
  serverVersion: string;
  store: QueueStore;
  origins: Set<string>;
  onBatchAdded: (record: BatchRecord) => void;
  log?: (message: string) => void;
  preAuthMs?: number;
  watchIntervalMs?: number;
};

export type Bridge = { port: number; pushStatus(batchId: string): void; close(): Promise<void> };

type Connection = {
  ws: WebSocket;
  authed: boolean;
  timer: NodeJS.Timeout;
  submits: WindowCounter;
  /** batch id → stateKey of the last status sent */
  watched: Map<string, string>;
};

/** Changes on every transition, even two within the same millisecond. */
function stateKey(state: BatchState): string {
  return `${state.status}|${state.history.length}|${state.updatedAt}`;
}

const TERMINAL = new Set<string>(['done', 'partial', 'failed', 'cancelled']);

export function statusMessage(batchId: string, state: BatchState): ServerMessage {
  return {
    v: 1,
    type: 'batch.status',
    batchId,
    status: state.status,
    ...(state.note ? { note: state.note } : {}),
    ...(state.report ? { report: state.report } : {}),
    updatedAt: state.updatedAt,
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export async function startBridge(deps: BridgeDeps, ports: readonly number[] = PORTS): Promise<Bridge | null> {
  const log = deps.log ?? defaultLog;
  const bound = await listenOnFirstFree(
    () =>
      createServer((_req, res) => {
        res.writeHead(404).end();
      }),
    ports,
  );
  if (!bound) return null;
  const { server, port } = bound;
  server.on('error', (error) => log(`Bridge server error: ${error.message}`));

  // Headroom above the limit so an oversized message gets a polite `too-large` instead of a dropped socket.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES + 1024 * 1024 });
  const connections = new Set<Connection>();

  server.on('upgrade', (req, socket, head) => {
    // Node removes its own error listener before 'upgrade'; a reset must not become an unhandled error.
    socket.on('error', (error) => log(`Upgrade socket error: ${error.message}`));
    // The Origin check is the whole gate: only the Pickfix extension can open a socket from a browser.
    const check = checkUpgrade(req, port, deps.origins);
    if (!check.ok) {
      socket.end(`HTTP/1.1 ${check.status} ${check.status === 403 ? 'Forbidden' : 'Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws));
  });

  function send(conn: Connection, message: ServerMessage): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(encodeMessage(message));
  }

  function fail(conn: Connection, code: ErrorCode, message: string, requestId?: string): void {
    send(conn, { v: 1, type: 'error', code, message, ...(requestId ? { requestId } : {}) });
  }

  function sendStatus(conn: Connection, batchId: string): void {
    const state = deps.store.readState(batchId);
    if (!state || conn.watched.get(batchId) === stateKey(state)) return;
    conn.watched.set(batchId, stateKey(state));
    send(conn, statusMessage(batchId, state));
    // A finished batch never changes again, so stop polling it.
    if (TERMINAL.has(state.status)) conn.watched.delete(batchId);
  }

  function accept(ws: WebSocket): void {
    const conn: Connection = {
      ws,
      authed: false,
      submits: new WindowCounter(20, 60_000),
      watched: new Map(),
      timer: setTimeout(() => {
        if (!conn.authed) ws.close(1008, 'Handshake timeout');
      }, deps.preAuthMs ?? 10_000),
    };
    connections.add(conn);
    ws.on('close', () => {
      clearTimeout(conn.timer);
      connections.delete(conn);
    });
    ws.on('error', (error) => log(`WebSocket error: ${error.message}`));
    ws.on('message', (data) => {
      try {
        onMessage(conn, toBuffer(data));
      } catch (error) {
        log(`Failed to handle a message: ${(error as Error).stack ?? String(error)}`);
        fail(conn, 'internal', 'The server could not handle that message.');
      }
    });
    send(conn, { v: 1, type: 'server.info', app: APP_ID, protocol: PROTOCOL_VERSION, serverVersion: deps.serverVersion });
  }

  function onMessage(conn: Connection, buffer: Buffer): void {
    if (buffer.length > MAX_MESSAGE_BYTES) {
      fail(conn, 'too-large', 'The message is larger than 15 MB. Send fewer items or remove some screenshots.');
      if (!conn.authed) conn.ws.close(1008, 'Message too large');
      return;
    }
    const parsed = parseClientMessage(buffer.toString('utf8'));
    if (!parsed.ok) {
      if (!parsed.ignore) fail(conn, 'invalid', parsed.error);
      if (!conn.authed) conn.ws.close(1008, 'Not authenticated');
      return;
    }
    const message = parsed.message;
    if (message.type === 'ping') return send(conn, { v: 1, type: 'pong' });
    if (!conn.authed) {
      if (message.type === 'hello') return onHello(conn, message);
      fail(conn, 'unauthorized', 'Send hello first.');
      conn.ws.close(1008, 'Not authenticated');
      return;
    }
    switch (message.type) {
      case 'hello':
        return onHello(conn, message);
      case 'batch.submit':
        return onSubmit(conn, message);
      case 'batch.watch':
        conn.watched = new Map();
        for (const id of message.batchIds) sendStatus(conn, id);
        return;
      case 'batch.cancel':
        return onCancel(conn, message);
    }
  }

  function onHello(conn: Connection, message: Extract<ClientMessage, { type: 'hello' }>): void {
    if (message.protocol !== PROTOCOL_VERSION) {
      fail(conn, 'protocol-mismatch', `This server speaks protocol ${PROTOCOL_VERSION} and the extension speaks protocol ${message.protocol}. Update Pickfix and pickfix-mcp.`);
      conn.ws.close(1008, 'Protocol mismatch');
      return;
    }
    conn.authed = true;
    clearTimeout(conn.timer);
    send(conn, { v: 1, type: 'welcome', session: deps.session });
  }

  function onSubmit(conn: Connection, message: Extract<ClientMessage, { type: 'batch.submit' }>): void {
    if (conn.submits.exceeded()) {
      fail(conn, 'rate-limited', 'Too many batches in one minute. Wait a moment and send again.', message.requestId);
      return;
    }
    conn.submits.record();
    let result: ReturnType<QueueStore['add']>;
    try {
      result = deps.store.add(message.batch, deps.session.sessionId);
    } catch (error) {
      log(`Could not store batch ${message.batch.id}: ${(error as Error).message}`);
      fail(conn, 'internal', `Could not store the batch: ${(error as Error).message}`, message.requestId);
      return;
    }
    conn.watched.set(message.batch.id, stateKey(result.record.state));
    send(conn, { v: 1, type: 'batch.accepted', requestId: message.requestId, batchId: message.batch.id, status: result.record.state.status });
    if (result.created) deps.onBatchAdded(result.record);
  }

  function onCancel(conn: Connection, message: Extract<ClientMessage, { type: 'batch.cancel' }>): void {
    const result = deps.store.cancel(deps.session.sessionId, message.batchId);
    if (result.ok) {
      conn.watched.delete(message.batchId);
      sendStatus(conn, message.batchId);
      pushStatus(message.batchId);
      return;
    }
    if (result.reason === 'not-found') fail(conn, 'not-found', `No batch ${message.batchId} in this repository.`, message.requestId);
    else fail(conn, 'conflict', 'Claude is already working on this batch, so it can no longer be cancelled.', message.requestId);
  }

  function pushStatus(batchId: string): void {
    for (const conn of connections) if (conn.authed && conn.watched.has(batchId)) sendStatus(conn, batchId);
  }

  const watcher = setInterval(() => {
    for (const conn of connections) {
      if (!conn.authed) continue;
      for (const id of conn.watched.keys()) sendStatus(conn, id);
    }
  }, deps.watchIntervalMs ?? 1000);
  watcher.unref();

  return {
    port,
    pushStatus,
    close: async () => {
      clearInterval(watcher);
      for (const conn of connections) conn.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
