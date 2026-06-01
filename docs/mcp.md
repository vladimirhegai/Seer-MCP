# MCP Setup

Seer speaks the Model Context Protocol over stdio. Any MCP-capable agent can
talk to it. The annoying part of MCP is that every client invented its own
config file, root key, and location, so this page covers all of them, plus a
command that writes them for you.

---

## The fast path: `seer init`

From inside the repo you want indexed:

```bash
npx seer-mcp init
```

This writes project-local MCP config for Claude Code, Cursor, VS Code, Codex,
and Gemini, then drops the agent guidance files each client actually reads:
`AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` as needed. It is idempotent: run it
again and it leaves existing entries alone unless you pass `--force`.

(If you installed Seer globally with `npm install -g seer-mcp`, the command is
just `seer init`. From a source checkout it is `node dist/cli/index.js init`.)

### Options

| Flag | What it does |
|---|---|
| `--client <names>` | Comma-separated subset: `claude,cursor,vscode,codex,gemini,antigravity,windsurf`, or `all`. |
| `--global` | Write the user-level config instead of the project-local one. |
| `--npx` | Emit a portable `npx -y seer-mcp mcp` launcher (no machine paths). |
| `--pkg <name>` | Package name for the `--npx` launcher (default `seer-mcp`). |
| `--command <cmd>` | Override the launch command entirely (advanced). |
| `--no-agents` | Do not write agent guidance files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`). |
| `--print` | Show the plan and the exact snippets without writing anything. |
| `--force` | Overwrite an existing `seer` entry / managed guidance block. |
| `--db <path>` | Use a custom database path in the launcher. |

### What the launcher looks like

`seer init` picks the right launcher automatically based on how Seer is
installed:

- **Installed from npm** (via `npx`, or a global/local install): it writes the
  portable launcher, which works the same on any machine and is safe to commit.

  ```
  npx -y seer-mcp mcp
  ```

- **Running from a source checkout**: it writes an absolute path to your local
  build, so changes you make are picked up without publishing.

  ```
  node /abs/path/to/Seer-Core/dist/cli/index.js mcp --workspace /abs/path/to/your-repo
  ```

Force the portable form with `--npx`, or override it entirely with
`--command "<cmd>"`.

---

## Manual configuration

Prefer to paste it yourself? Here is the exact config for each client. The
launcher (`command` + `args`) is the same everywhere; only the file location and
the surrounding keys differ. Replace the path with your absolute path, or use
the `npx` form.

### Claude Code

Project-local: `.mcp.json` at the repo root. User-level: `~/.claude.json`.
Claude Code project instructions are read from `CLAUDE.md`, so `seer init`
also creates a managed `CLAUDE.md` block that imports `AGENTS.md`.

```json
{
  "mcpServers": {
    "seer": {
      "command": "npx",
      "args": ["-y", "seer-mcp", "mcp"]
    }
  }
}
```

You can also use the CLI: `claude mcp add seer -- npx -y seer-mcp mcp`.

### Cursor

Project-local: `.cursor/mcp.json`. User-level: `~/.cursor/mcp.json`. Same shape
as Claude Code (the `mcpServers` key).

```json
{
  "mcpServers": {
    "seer": { "command": "npx", "args": ["-y", "seer-mcp", "mcp"] }
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
      "args": ["-y", "seer-mcp", "mcp"]
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
args = ["-y", "seer-mcp", "mcp"]
```

### Gemini CLI

Project-local: `.gemini/settings.json`. User-level: `~/.gemini/settings.json`.

```json
{
  "mcpServers": {
    "seer": { "command": "npx", "args": ["-y", "seer-mcp", "mcp"] }
  }
}
```

### Google Antigravity

Antigravity uses dedicated MCP config files with the `mcpServers` key.
`seer init --client antigravity` writes the current editor path
`~/.gemini/antigravity/mcp_config.json`, the CLI path
`~/.gemini/antigravity-cli/mcp_config.json`, the workspace path
`.agents/mcp_config.json`, and legacy compatibility paths used by older
Antigravity/Gemini migrations. Because several of these are user-level files,
Antigravity is opt-in (`--client antigravity` or `--client all`).

```json
{
  "mcpServers": {
    "seer": { "command": "npx", "args": ["-y", "seer-mcp", "mcp"] }
  }
}
```

### Windsurf

User-level: `~/.codeium/windsurf/mcp_config.json`. Uses the `mcpServers` key.
Windsurf is also opt-in because it does not have a project-local MCP file.

```json
{
  "mcpServers": {
    "seer": { "command": "npx", "args": ["-y", "seer-mcp", "mcp"] }
  }
}
```

---

## What about editor extensions?

MCP config is per-tool, not per-surface, so the editor extensions read the same
config as their command-line sibling. You do not configure them separately.

- The **Claude Code** extension (VS Code / JetBrains) reads the same `.mcp.json`
  as the Claude Code CLI. The `claude` entry covers both.
- The **Codex** IDE extension reads the same `~/.codex/config.toml` as the Codex
  CLI. The `codex` entry covers both.
- The **Gemini** CLI and Gemini Code Assist share `.gemini/settings.json`.
- **Antigravity** has split editor, CLI, and workspace MCP files; the
  `antigravity` entry writes all supported locations Seer knows about.
- **Windsurf** Cascade reads `~/.codeium/windsurf/mcp_config.json`; the
  `windsurf` entry covers it.
- The separate **VS Code** entry (`.vscode/mcp.json`, `servers` key) is for
  VS Code's own native MCP and GitHub Copilot's agent mode, which is a different
  consumer from the Claude/Codex extensions above.

So if you run, say, the Claude Code extension inside VS Code, the `claude` entry
is what configures it; you do not also need the `vscode` entry. `seer init`
writes all of them, so whichever surface you switch to is already set up.

---

## Letting the agent know Seer exists

Configuring the server is half the job. The other half is making sure the agent
actually reaches for it instead of grepping. `seer init` writes an `AGENTS.md`
block for agents that read it (Codex, Cursor, Windsurf, and recent
Antigravity), a `CLAUDE.md` import for Claude Code, and a `GEMINI.md` mirror
for Gemini-family clients. The MCP server also sends concise Seer usage
instructions during `initialize`, so clients that surface server instructions
get the same nudge even before reading repo files:

1. `seer_health` to confirm the index is live.
2. `seer_architecture` or `seer_boundaries` to orient.
3. `seer_preflight { symbol }` before editing an unfamiliar symbol.
4. `seer_preflight { fromRef, toRef }` for the blast radius of a diff.
5. `seer_behavior` / `seer_history` for tests and blame.
6. `seer_skeleton { file }` to read a big file cheaply.

The managed block is wrapped in `<!-- seer:begin -->` / `<!-- seer:end -->`
markers so a re-run updates it cleanly without clobbering the rest of your
existing instruction files.

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
