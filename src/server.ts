import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PORT_FIRST, PORT_LAST, type Session } from '@pickfix/protocol';
import { startBridge, type Bridge } from './bridge.js';
import { announce } from './channel.js';
import { pickfixHome } from './home.js';
import { log } from './log.js';
import { SERVER_INSTRUCTIONS, registerPrompts } from './prompts.js';
import { QueueStore } from './queue-store.js';
import { resolveRepoRoot } from './repo.js';
import { registerTools, type ToolDeps } from './tools.js';
import { SERVER_VERSION } from './version.js';
import { allowedOrigins } from './ws-guard.js';

export async function main(): Promise<void> {
  const home = pickfixHome();
  let linkProblem: string | undefined;

  const mcp = new McpServer(
    { name: 'pickfix', version: SERVER_VERSION },
    { capabilities: { experimental: { 'claude/channel': {} } }, instructions: SERVER_INSTRUCTIONS },
  );
  let resolveDeps!: (deps: ToolDeps) => void;
  let rejectDeps!: (error: Error) => void;
  const depsReady = new Promise<ToolDeps>((resolve, reject) => {
    resolveDeps = resolve;
    rejectDeps = reject;
  });
  depsReady.catch(() => {});
  registerTools(mcp, () => depsReady);
  registerPrompts(mcp);

  let bridge: Bridge | null = null;
  let recoveryTimer: NodeJS.Timeout | undefined;

  async function setUp(): Promise<void> {
    let roots: string[] = [];
    if (mcp.server.getClientCapabilities()?.roots) {
      try {
        roots = (await mcp.server.listRoots(undefined, { timeout: 2000 })).roots.map((r) => r.uri);
      } catch {
        // Clients may advertise roots and still not answer; fall back to the environment.
      }
    }
    const repoRoot = resolveRepoRoot({ roots });
    const session: Session = {
      sessionId: randomUUID(),
      name: basename(repoRoot) || repoRoot,
      cwd: repoRoot,
      startedAt: new Date().toISOString(),
      agent: mcp.server.getClientVersion()?.name ?? 'unknown',
      pid: process.pid,
    };
    const store = new QueueStore({ home, repoRoot });
    store.prune();
    store.recover();

    try {
      bridge = await startBridge({
        session,
        serverVersion: SERVER_VERSION,
        store,
        origins: allowedOrigins(),
        onBatchAdded: (record) => void announce(mcp.server, record),
      });
      if (!bridge) linkProblem = `All ports ${PORT_FIRST}–${PORT_LAST} are in use by other sessions. Close one of them and restart this session.`;
    } catch (error) {
      linkProblem = `Could not start the extension link: ${(error as Error).message}`;
    }
    log(linkProblem ?? `Listening on ws://127.0.0.1:${bridge?.port}/pickfix for ${repoRoot}`);

    resolveDeps({
      store,
      session,
      repoRoot,
      linkStatus: () => ({ port: bridge?.port ?? null, reason: linkProblem }),
      onStatusChanged: (batchId) => bridge?.pushStatus(batchId),
    });

    const announceIds = async (ids: string[]) => {
      for (const id of ids) {
        const record = store.get(id);
        if (record) await announce(mcp.server, record);
      }
    };
    await announceIds(store.list(['queued']).map((s) => s.id));
    recoveryTimer = setInterval(() => void announceIds(store.recover()), 30_000);
    recoveryTimer.unref();
  }

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(0), 2000).unref();
    if (recoveryTimer) clearInterval(recoveryTimer);
    void (bridge?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  mcp.server.oninitialized = () => {
    setUp().catch((error) => {
      log(`Start-up failed: ${(error as Error).stack ?? String(error)}`);
      rejectDeps(new Error(`Pickfix could not start: ${(error as Error).message ?? String(error)}`));
    });
  };
  mcp.server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await mcp.connect(new StdioServerTransport());
}

main().catch((error) => {
  log(`Fatal: ${(error as Error).stack ?? String(error)}`);
  process.exit(1);
});
