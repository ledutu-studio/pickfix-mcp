import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIX_BODY, FIX_DESCRIPTION, PAIR_BODY, PAIR_DESCRIPTION } from '../src/prompts.js';
import { SERVER_VERSION } from '../src/version.js';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** Splits a SKILL.md into its frontmatter fields and its body. */
function skill(path: string): { fields: Record<string, string>; body: string } {
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path} has no frontmatter`);
  const fields = Object.fromEntries(
    match[1]!.split('\n').map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]),
  );
  return { fields, body: match[2]!.trimEnd() };
}

describe('plugin packaging', () => {
  it('declares one marketplace with the plugin in ./plugin', () => {
    const marketplace = json('.claude-plugin/marketplace.json');
    expect(marketplace.name).toBe('pickfix');
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'pickfix', source: './plugin' })]);
  });

  it('runs the bundled server and binds the channel to it', () => {
    const plugin = json('plugin/.claude-plugin/plugin.json');
    expect(plugin.name).toBe('pickfix');
    expect(plugin.mcpServers.pickfix).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs'] });
    expect(plugin.channels).toEqual([{ server: 'pickfix', displayName: 'PickFix' }]);
  });

  it('keeps every version in step', () => {
    expect(json('plugin/.claude-plugin/plugin.json').version).toBe(SERVER_VERSION);
    expect(json('package.json').version).toBe(SERVER_VERSION);
  });

  it('runs the bundled hook on UserPromptSubmit in exec form', () => {
    const hooks = json('plugin/hooks/hooks.json');
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0]).toEqual({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs'],
      timeout: 5,
    });
  });
});

describe('skills match the MCP prompt texts', () => {
  it('fix', () => {
    const { fields, body } = skill('plugin/skills/fix/SKILL.md');
    expect(fields.name).toBe('fix');
    expect(fields.description).toBe(FIX_DESCRIPTION);
    expect(body).toBe(FIX_BODY);
  });

  it('pair', () => {
    const { fields, body } = skill('plugin/skills/pair/SKILL.md');
    expect(fields.name).toBe('pair');
    expect(fields.description).toBe(PAIR_DESCRIPTION);
    expect(body).toBe(PAIR_BODY);
  });
});
