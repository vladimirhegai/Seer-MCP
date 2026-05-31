# MCP Setup

Seer speaks the Model Context Protocol over stdio. Any MCP-capable agent can
talk to it. The annoying part of MCP is that every client invented its own
config file, root key, and location, so this page covers all of them, plus a
command that writes them for you.

---

## The fast path: `seer init`

From inside the repo you want indexed:

```bash
seer init
```

This writes a project-local MCP config for Claude Code, Cursor, VS Code, Codex,
and Gemini, and drops an `AGENTS.md` guidance block so the agent knows Seer
exists and when to call it. It is idempotent: run it again and it leaves
existing entries alone unless you pass `--force`.

### Options

| Flag | What it does |
|---|---|
| `--client <names>` | Comma-separated subset: `claude,cursor,vscode,codex,gemini,antigravity`, or `all`. |
| `--global` | Write the user-level config instead of the project-local one. |
| `--npx` | Emit a portable `npx -y seer-core mcp` launcher (no machine paths). |
| `--pkg <name>` | Package name for the `--npx` launcher (default `seer-core`). |
| `--command <cmd>` | Override the launch command entirely (advanced). |
| `--no-agents` | Do not write `AGENTS.md`. |
| `--print` | Show the plan and the exact snippets without writing anything. |
| `--force` | Overwrite an existing `seer` entry / `AGENTS.md` block. |
| `--db <path>` | Use a custom database path in the launcher. |

### What the launcher looks like

By default `seer init` writes an absolute-path launcher, which works right now
without publishing anything:

```
node /abs/path/to/Seer-Core/dist/cli/index.js mcp --workspace /abs/path/to/your-repo
```

If you have published or linked the package, `--npx` gives you a portable
launcher that any teammate can use as-is (it relies on the client starting the
server with the repo as its working directory):

```
npx -y seer-core mcp
```

---

## Manual configuration

Prefer to paste it yourself? Here is the exact config for each client. The
launcher (`command` + `args`) is the same everywhere; only the file location and
the surrounding keys differ. Replace the path with your absolute path, or use
the `npx` form.

### Claude Code

Project-local: `.mcp.json` at the repo root. User-level: `~/.claude.json`.

```json
{
  "mcpServers": {
    "seer": {
      "command": "npx",
      "args": ["-y", "seer-core", "mcp"]
    }
  }
}
```

You can also use the CLI: `claude mcp add seer -- npx -y seer-core mcp`.

### Cursor

Project-local: `.cursor/mcp.json`. User-level: `~/.cursor/mcp.json`. Same shape
as Claude Code (the `mcpServers` key).

```json
{
  "mcpServers": {
    "seer": { "command": "npx", "args": ["-y", "seer-core", "mcp"] }
  }
}
```

### VS Code (Copilot / native MCP)

Project-local: `.vscode/mcp.json`. Note the different root key (`servers`) and
the required `type`.

```json
{
  "servers": {
    "seer": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "seer-core", "mcp"]
    }
  }
}
```

### OpenAI Codex

User-level: `~/.codex/config.toml`. Project-local: `.codex/config.toml`. This one
is TOML, not JSON.

```toml
[mcp_servers.seer]
command = "npx"
args = ["-y", "seer-core", "mcp"]
```

### Gemini CLI

Project-local: `.gemini/settings.json`. User-level: `~/.gemini/settings.json`.

```json
{
  "mcpServers": {
    "seer": { "command": "npx", "args": ["-y", "seer-core", "mcp"] }
  }
}
```

### Google Antigravity

User-level only, shared across the Antigravity IDE and CLI:
`~/.gemini/config/mcp_config.json`. Uses the `mcpServers` key. Because there is
no project-local file, `seer init` only touches this one when you ask for it
(`--client antigravity` or `--client all`).

```json
{
  "mcpServers": {
    "seer": { "command": "npx", "args": ["-y", "seer-core", "mcp"] }
  }
}
```

---

## Letting the agent know Seer exists

Configuring the server is half the job. The other half is making sure the agent
actually reaches for it instead of grepping. `seer init` writes an `AGENTS.md`
block (the cross-agent convention that Codex, Cursor, Gemini, and Claude Code
all read) describing what Seer is and the recommended workflow:

1. `seer_health` to confirm the index is live.
2. `seer_architecture` or `seer_boundaries` to orient.
3. `seer_preflight { symbol }` before editing an unfamiliar symbol.
4. `seer_preflight { fromRef, toRef }` for the blast radius of a diff.
5. `seer_behavior` / `seer_history` for tests and blame.
6. `seer_skeleton { file }` to read a big file cheaply.

The block is wrapped in `<!-- seer:begin -->` / `<!-- seer:end -->` markers so a
re-run updates it cleanly without clobbering the rest of your `AGENTS.md`.

---

## Server options

The MCP server itself is `seer mcp`:

```bash
seer mcp --workspace <repo-path> [--db <path>] [--no-watch] [--no-jit]
```

- `--workspace` defaults to the current working directory.
- `--no-watch` disables the background file watcher.
- `--no-jit` disables the freshness check that runs before each query.

The full tool surface is documented in the [Tool Guide](tools.md).

---

## Troubleshooting

**The agent does not list any Seer tools.** Reload the MCP servers (most clients
have a refresh button or need a restart). Confirm the config file is where that
client expects it, and that `node`/`npx` is on the PATH the client launches with.

**First query is slow.** That is the initial index. It runs once, then the cache
makes everything fast. You can pre-build it with `seer index .`.

**"Could not find .seer/graph.db".** A CLI query was run outside the repo. Pass
`--db <path>` or run from inside the workspace.

**Stale results.** Seer hashes files before each query and re-parses anything
that changed, so this should not happen. If it does, `seer index . --reset`
rebuilds from scratch.
