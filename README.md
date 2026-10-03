# pickfix-mcp

The local half of **PickFix**. The PickFix browser extension lets developers, QA and PMs pick an element on a running web app, say what is wrong (or rewrite the text in place, comment on the page, record the steps to a bug) and press **Send to Claude**. `pickfix-mcp` receives that feedback on your machine and hands it to the coding agent working on the repository, which fixes it and reports back to the extension.

## Install in Claude Code

```text
/plugin marketplace add <this repository's git URL>
/plugin install pickfix@pickfix
```

Restart Claude Code in your project. The plugin starts one `pickfix-mcp` server per session.

### Let Claude start fixing as soon as feedback arrives (optional)

Channels are a Claude Code research preview. To have a batch pushed straight into the session, start Claude with:

```bash
claude --dangerously-load-development-channels plugin:pickfix@pickfix
```

Claude Code shows a warning first; choose **I am using this for local development**. A shell alias helps: `alias claudefix='claude --dangerously-load-development-channels plugin:pickfix@pickfix'`.

Without the flag everything still works: run `/pickfix:fix` when the extension shows **Queued**. A hook also reminds Claude of waiting feedback when you send a prompt.

## Pair the extension (once per machine)

1. In Claude Code, run `/pickfix:pair`.
2. Open the PickFix panel in Chrome and type the 6-digit code within 2 minutes.

Every session on the machine shares the pairing. To revoke it, delete `~/.pickfix/token` and pair again; the next `pickfix-mcp` start creates a new token.

## Other agents (Cursor, Codex, …)

`pickfix-mcp` is not on npm yet. Clone this repository and add a stdio MCP server that runs `node <clone>/plugin/dist/server.mjs` (the bundle needs no install). To pair from a terminal, run `node <clone>/plugin/dist/server.mjs pair`. These clients have no channel push: ask the agent to use the `fix` prompt, or to call `pickfix_list_batches` and follow the tool descriptions.

## What the agent gets

| Tool | Purpose |
|---|---|
| `pickfix_status` | Session, repository, port, pairing state, batch counts |
| `pickfix_list_batches` | Queued and working batches (or by status) |
| `pickfix_claim_batch` | Claims a batch and returns its items as markdown plus screenshots |
| `pickfix_report` | Reports `done` / `partial` / `failed` with a summary and per-item results |
| `pickfix_import` | Queues a JSON file exported from the extension |
| `pickfix_pair_code` | A pairing code for the extension |

A batch can be claimed by one session only, so two Claude windows on the same repository never fix the same feedback twice.

## Security model

- The server listens on `127.0.0.1` only, on the first free port of 47400–47409, path `/pickfix`.
- A connection must come from the PickFix extension (`Origin: chrome-extension://<PickFix id>`) to a loopback `Host`; web pages and DNS-rebinding hosts are refused at the handshake.
- The extension must present the machine's pairing token, kept in `~/.pickfix/token` (mode 0600).
- Everything captured from a web page is passed to the agent as fenced, untrusted data with an instruction never to follow it.
- The server has no tool that runs commands or writes files in your repository; code changes go through your agent's normal permissions.

Full privacy policy (English and Vietnamese): [PRIVACY.md](PRIVACY.md).

## Files

```text
~/.pickfix/                 0700
  token                     pairing token, 0600
  pairing.json              the current pairing code, 0600
  queue/<repo-key>/<batch>/ batch.json, state.json, screenshots
```

Finished batches are deleted after 7 days. Set `PICKFIX_HOME` to use another directory.

## Protocol

The extension and server speak protocol 1 over WebSocket; the full contract is section 5 of `docs/specs/2026-10-02-pickfix-mcp-design.md`, and its types and schemas ship as `@pickfix/protocol` (`packages/protocol`).

| Direction | Messages |
|---|---|
| Server → extension | `server.info`, `welcome`, `paired`, `batch.accepted`, `batch.status`, `pong`, `error` |
| Extension → server | `hello`, `pair`, `batch.submit`, `batch.watch`, `batch.cancel`, `ping` |

## Development

```bash
pnpm install
pnpm test          # unit tests
pnpm test:e2e      # builds, then drives plugin/dist/server.mjs end to end
pnpm build         # rebuild plugin/dist (commit the result; a test checks it is fresh)
pnpm compile       # type-check
pnpm --filter @pickfix/protocol build   # build the protocol package the extension links to
```

`PICKFIX_EXTENSION_IDS=<id>[,<id>]` allows extra extension ids, for unpacked development builds signed with another key.

The extension's id comes from the key created by `pnpm extension-key` (kept at `~/.pickfix-signing/pickfix-extension.pem`, outside every repository). Back that file up: losing it means a new extension id and a protocol release.
