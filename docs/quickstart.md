# Quick Start

Seer is a local MCP server. Run setup from the repo you want agents to index.

Requirements: Node.js 24+.

## Install

Best default:

```bash
npx seer-mcp init --auto
```

What it does:

- Writes repo-local MCP config for clients that support it.
- Adds detected editor-global clients such as Antigravity and Windsurf.
- Pins editor-global launchers to this repo with `--workspace`.
- Writes `AGENTS.md`; `CLAUDE.md` and `GEMINI.md` are small imports to `AGENTS.md` when needed.

Zero global changes:

```bash
npx seer-mcp init
```

Everything Seer knows about:

```bash
npx seer-mcp init --client all
```

Then restart or reload your agent and ask it to call `seer_health`.

## Client Support

| Client | Status | Scope Seer writes |
|---|---:|---|
| Claude Code | Supported | repo-local `.mcp.json` |
| Cursor | Supported | repo-local `.cursor/mcp.json` |
| VS Code native MCP / Copilot | Supported | repo-local `.vscode/mcp.json` |
| OpenAI Codex CLI / extension | Supported | repo-local `.codex/config.toml` |
| Gemini CLI | Supported | repo-local `.gemini/settings.json` |
| Google Antigravity | Supported | `.agents/mcp_config.json` plus detected/global Antigravity configs |
| Windsurf | Supported | user-level `~/.codeium/windsurf/mcp_config.json` |

## Update

Use this after upgrading Seer, or after an older install that missed
`--workspace` in editor-global configs:

```bash
npx seer-mcp update
```

`update` refreshes existing Seer MCP entries for the current repo and updates
the managed guidance block. It does not install new clients. Use
`init --auto` or `init --client all` for that.

## Indexing

Seer indexes on the first MCP query. The index is cached at:

```text
<repo>/.seer/graph.db
```

Optional pre-index:

```bash
npx seer-mcp index .
```

Delete `.seer/` any time; it rebuilds.

## Direct CLI

```bash
npx seer-mcp index .
npx seer-mcp architecture
npx seer-mcp preflight --symbol foo
```

With a global npm install:

```bash
npm install -g seer-mcp
seer index .
```

## More

- [MCP Setup](mcp.md)
- [CLI Reference](cli.md)
- [Tool Guide](tools.md)
