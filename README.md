# pickfix-mcp

[![npm](https://img.shields.io/npm/v/pickfix-mcp)](https://www.npmjs.com/package/pickfix-mcp)
[![license](https://img.shields.io/npm/l/pickfix-mcp)](LICENSE)

The local half of **PickFix**. The PickFix browser extension lets developers, QA and PMs pick an element on a running web app, say what is wrong (or rewrite the text in place, comment on the page, record the steps to a bug) and press **Send to Claude**. `pickfix-mcp` receives that feedback on your machine and hands it to the coding agent working on the repository, which fixes it and reports back to the extension.

```text
Chrome: PickFix extension ──WebSocket, 127.0.0.1──▶ pickfix-mcp ──MCP──▶ Claude Code
   pick · comment · send        (extension origin only)   queue        fixes the code
   ◀──────────────── Queued → Claude is fixing → Done, with a summary ─────────────────
```

[Tiếng Việt](#tiếng-việt) · [Privacy](PRIVACY.md)

## Quick start

1. **Install the extension:** [PickFix on the Chrome Web Store](https://chromewebstore.google.com/detail/eehanlcaccamfaalnfcikkdneffjkife) (in review; the link works once it is published).
2. **Install the plugin in Claude Code**, in your project:

   ```text
   /plugin marketplace add ledutu-studio/pickfix-mcp
   /plugin install pickfix@pickfix
   ```

   Restart Claude Code. The plugin starts one `pickfix-mcp` server per session.
3. **Open the PickFix panel** on a local page in Chrome. It finds every running session by itself; there is nothing to pair.

Then pick an element, write what should change and press **Send to Claude**. Requires Node.js 20 or newer.

### Let Claude start fixing as soon as feedback arrives (optional)

Channels are a Claude Code research preview. To have a batch pushed straight into the session, start Claude with:

```bash
claude --dangerously-load-development-channels plugin:pickfix@pickfix
```

Claude Code shows a warning first; choose **I am using this for local development**. A shell alias helps: `alias claudefix='claude --dangerously-load-development-channels plugin:pickfix@pickfix'`.

Without the flag everything still works: run `/pickfix:fix` when the extension shows **Queued**. A hook also reminds Claude of waiting feedback when you send a prompt.

## Other agents (Cursor, Codex, Claude Desktop, …)

Run the server with `npx -y pickfix-mcp` as a stdio MCP server. For clients that use an `mcpServers` JSON file (Cursor's `.cursor/mcp.json`, Claude Desktop):

```json
{
  "mcpServers": {
    "pickfix": { "command": "npx", "args": ["-y", "pickfix-mcp"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.pickfix]
command = "npx"
args = ["-y", "pickfix-mcp"]
```

Start the client from your project folder: the server queues feedback per repository. These clients have no channel push: ask the agent to use the `fix` prompt, or to call `pickfix_list_batches` and follow the tool descriptions.

## What the agent gets

| Tool | Purpose |
|---|---|
| `pickfix_status` | Session, repository, port, batch counts |
| `pickfix_list_batches` | Queued and working batches (or by status) |
| `pickfix_claim_batch` | Claims a batch and returns its items as markdown plus screenshots |
| `pickfix_report` | Reports `done` / `partial` / `failed` with a summary and per-item results |
| `pickfix_import` | Queues a JSON file exported from the extension |

A batch can be claimed by one session only, so two Claude windows on the same repository never fix the same feedback twice.

## Security model

- The server listens on `127.0.0.1` only, on the first free port of 47400–47409, path `/pickfix`.
- A connection must come from the PickFix extension (`Origin: chrome-extension://<PickFix id>`) to a loopback `Host`; web pages, other extensions and DNS-rebinding hosts are refused at the handshake. Browsers do not let a page set `Origin`, so this is the gate; there is no pairing step. Programs already running under your account can still connect, as they can to any local port.
- Everything captured from a web page is passed to the agent as fenced, untrusted data with an instruction never to follow it.
- The server has no tool that runs commands or writes files in your repository; code changes go through your agent's normal permissions.

Full privacy policy (English and Vietnamese): [PRIVACY.md](PRIVACY.md).

## Files

```text
~/.pickfix/                 0700
  queue/<repo-key>/<batch>/ batch.json, state.json, screenshots
```

Finished batches are deleted after 7 days. Set `PICKFIX_HOME` to use another directory.

## Protocol

The extension and server speak protocol 2 over WebSocket; the full contract is section 5 of `docs/specs/2026-10-02-pickfix-mcp-design.md`, and its types and schemas ship as `@pickfix/protocol` (`packages/protocol`).

| Direction | Messages |
|---|---|
| Server → extension | `server.info`, `welcome`, `batch.accepted`, `batch.status`, `pong`, `error` |
| Extension → server | `hello`, `batch.submit`, `batch.watch`, `batch.cancel`, `ping` |

## Development

```bash
pnpm install
pnpm test          # unit tests
pnpm test:e2e      # builds, then drives plugin/dist/server.mjs end to end
pnpm build         # rebuild plugin/dist (commit the result; a test checks it is fresh)
pnpm compile       # type-check
pnpm --filter @pickfix/protocol build   # build the protocol package the extension links to
```

`PICKFIX_EXTENSION_IDS=<id>[,<id>]` allows extra extension ids, for unpacked builds made without the PickFix key.

The extension's id is its Chrome Web Store item id, `eehanlcaccamfaalnfcikkdneffjkife`. `EXTENSION_PUBLIC_KEY` in `@pickfix/protocol` is that item's public key (Developer Dashboard → Package → View public key); Google holds the private key, so nothing secret lives on a developer machine.

## Tiếng Việt

PickFix giúp dev frontend, QA và PM chỉ vào chỗ sai trên giao diện đang chạy, ghi cần sửa gì, rồi gửi thẳng cho Claude Code sửa trong source. `pickfix-mcp` là phần chạy trên máy bạn: nhận feedback từ extension qua `127.0.0.1` và chuyển cho Claude.

1. **Cài extension:** [PickFix trên Chrome Web Store](https://chromewebstore.google.com/detail/eehanlcaccamfaalnfcikkdneffjkife) (đang chờ duyệt).
2. **Cài plugin trong Claude Code**, ngay trong project của bạn:

   ```text
   /plugin marketplace add ledutu-studio/pickfix-mcp
   /plugin install pickfix@pickfix
   ```

   Khởi động lại Claude Code.
3. **Mở panel PickFix** trên trang localhost. Panel tự tìm các session đang chạy, không cần ghép nối.

Muốn Claude tự sửa ngay khi nhận feedback, mở Claude bằng `claude --dangerously-load-development-channels plugin:pickfix@pickfix`. Không dùng cờ này thì gõ `/pickfix:fix` khi panel hiện **Đang chờ**. Giao diện extension có tiếng Việt và tiếng Anh, đổi trong phần cài đặt của extension.

Cursor, Codex và các agent khác: thêm MCP server chạy `npx -y pickfix-mcp` (xem cấu hình ở trên). Chính sách quyền riêng tư: [PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
