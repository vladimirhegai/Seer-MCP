# MCP Setup

This page is the exact MCP configuration reference. For normal use, run setup
from the repo you want Seer to index:

```bash
npx seer-mcp init --auto
```

Then restart/reload your agent and ask it to call `seer_health`.

Seer supports Windows, macOS, and Linux. In paths below, `~` means your user
home directory (`%USERPROFILE%` on Windows).

## Pick A Client

| You use | Command |
|---|---|
| Antigravity IDE / CLI | `npx seer-mcp init --client antigravity` |
| Claude Code CLI | `npx seer-mcp init --client claude` |
| Cursor | `npx seer-mcp init --client cursor` |
| VS Code native MCP / Copilot | `npx seer-mcp init --client vscode` |
| Codex CLI / extension | `npx seer-mcp init --client codex` |
| Gemini CLI | `npx seer-mcp init --client gemini` |
| Windsurf | `npx seer-mcp init --client windsurf` |
| Everything supported | `npx seer-mcp init --client all` |
| Detected setup | `npx seer-mcp init --auto` |
| Repo-local defaults only | `npx seer-mcp init` |

Use `--print` to preview changes and `--force` to replace an existing `seer`
entry.

All `init`, `update`, and `uninstall` commands accept an optional workspace path:

```bash
npx seer-mcp init C:\path\to\repo --auto
```

## Workspace Rule

Seer indexes one workspace at a time.

Repo-local config starts Seer from the repo, so it can use:

```bash
npx -y seer-mcp mcp
```

Editor-wide config may start from the editor install directory, so it must pin
the repo:

```bash
npx -y seer-mcp mcp --workspace C:/path/to/repo
```

If `seer_health` shows your editor directory instead of your repo, rerun setup
from the repo:

```bash
npx seer-mcp init --auto --force
```

## Files By Client

| Client | Config file | MCP key | Scope |
|---|---|---|---|
| Claude Code CLI | `.mcp.json` | `mcpServers.seer` | repo |
| Cursor | `.cursor/mcp.json` | `mcpServers.seer` | repo |
| VS Code native MCP / Copilot | `.vscode/mcp.json` | `servers.seer` | repo |
| Codex | `.codex/config.toml` | `mcp_servers.seer` | repo |
| Gemini CLI | `.gemini/settings.json` | `mcpServers.seer` | repo |
| Antigravity workspace | `.agents/mcp_config.json` | `mcpServers.seer` | repo |
| Antigravity user | `~/.gemini/antigravity/mcp_config.json` | `mcpServers.seer` | user |
| Antigravity compatibility | `~/.gemini/antigravity-cli/mcp_config.json`, `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-ide/mcp_config.json` | `mcpServers.seer` | user |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.seer` | user |

Instruction files:

| File | Purpose |
|---|---|
| `AGENTS.md` | Main Seer guidance block for agents. |
| `CLAUDE.md` | Small Claude-specific import of `AGENTS.md`. |
| `GEMINI.md` | Small Gemini/Antigravity-specific import of `AGENTS.md`. |

## Manual Snippets

Most users should not need these. They are here for hand-edited configs.

Repo-local JSON clients:

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

Editor/user-level JSON clients:

```json
{
  "mcpServers": {
    "seer": {
      "command": "npx",
      "args": ["-y", "seer-mcp", "mcp", "--workspace", "C:/path/to/repo"]
    }
  }
}
```

VS Code native MCP:

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

Codex:

```toml
[mcp_servers.seer]
command = "npx"
args = ["-y", "seer-mcp", "mcp"]
```

Add `--workspace <repo>` to `args` whenever the config is user-level.

## Update

```bash
npx seer-mcp update
```

`update` refreshes existing Seer entries for the current repo. It also refreshes
the managed Seer block in `AGENTS.md` and the `CLAUDE.md` / `GEMINI.md` shims
when present.

Useful flags:

| Flag | Use |
|---|---|
| `--client all` | Refresh all known clients that already have Seer entries. |
| `--global` | Only refresh user-level config files. |
| `--force` | Re-point a user-level entry pinned to another repo. |
| `--no-agents` | Leave instruction files alone. |
| `--print` | Dry run. |

`update` does not add a brand-new client config. Use `init --client <name>` for
that.

## Uninstall

```bash
npx seer-mcp uninstall
```

`uninstall` removes Seer's MCP entries and managed instruction blocks. It
preserves other MCP servers and non-Seer text in the same files.

Useful flags:

| Flag | Use |
|---|---|
| `--client antigravity` | Remove one client only. |
| `--global` | Only remove user-level entries. |
| `--force` | Remove user-level entries even if pinned to another repo. |
| `--no-agents` | Leave `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` alone. |
| `--print` | Dry run. |

Uninstall does not delete `<repo>/.seer/graph.db`. Delete `.seer/` manually if
you want to remove the index cache.

## Server Command

The MCP server command is:

```bash
npx seer-mcp mcp --workspace <repo>
```

Options:

| Flag | Use |
|---|---|
| `--workspace <repo>` | Workspace to index. Defaults to current directory. |
| `--db <path>` | Custom SQLite database path. |
| `--no-watch` | Disable the file watcher. |
| `--no-jit` | Disable per-query freshness checks. |

## Test From A Terminal

```bash
npx seer-mcp index .
npx seer-mcp health
npx seer-mcp symbols runInit --top 5
```
