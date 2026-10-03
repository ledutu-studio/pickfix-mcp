import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_INSTRUCTIONS, registerPrompts } from '../src/prompts.js';
import { registerTools, type ToolDeps } from '../src/tools.js';

export async function startMcp(deps: ToolDeps): Promise<{ client: Client; close(): Promise<void> }> {
  const server = new McpServer({ name: 'pickfix', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, async () => deps);
  registerPrompts(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

export function text(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}
