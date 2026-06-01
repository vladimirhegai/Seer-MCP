# MCP Setup

Seer runs as an MCP stdio server:

```bash
npx -y seer-mcp mcp --workspace <repo>
```

Run setup from the repo you want indexed.

## Recommended Install

```bash
npx seer-mcp init --auto
```

`--auto` writes repo-local configs and adds detected editor-global clients.
Editor-global configs are always pinned with `--workspace <repo>` so Seer does
not accidentally index the editor install directory.

Safer repo-only install:

```bash
npx seer-mcp init
```

Install every known client:

```bash
npx seer-mcp init --client all
```

Dry run:

```bash
npx seer-mcp init --auto --print
```

## Scope Model

Seer is repo-specific.

| Scope | What it means | Example |
|---|---|---|
| Repo-local | Config lives in the repo and starts Seer from that repo. | `.mcp.json`, `.codex/config.toml` |
| Editor-global | Config lives in your user profile, so Seer must be pinned to one repo with `--workspace`. | Antigravity, Windsurf |
| Index | The SQLite index for one repo. | `<repo>/.seer/graph.db` |

Project-local npx launchers omit `--workspace` because the agent launches them
from the repo. User/editor-global launchers include `--workspace` because their
default cwd is usually the editor, not your project.

## Update

```bash
npx seer-mcp update
```

`update` refreshes existing Seer MCP entries and guidance files for the current
repo. It fixes old global launchers that were missing `--workspace`.

Useful flags:

| Flag | Use |
|---|---|
| `--client all` | Refresh all known clients. |
| `--global` | Only refresh user-level configs. |
| `--force` | Re-point a global Seer entry that is pinned to another repo. |
| `--print` | Show changes without writing. |

## Uninstall

```bash
npx seer-mcp uninstall
```

By default, uninstall removes Seer entries for this repo and strips Seer's
managed block from `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.

Useful flags:

| Flag | Use |
|---|---|
| `--client antigravity` | Remove only one client. |
| `--global` | Only target user-level configs. |
| `--no-agents` | Leave guidance files alone. |
| `--force` | Remove global Seer entries even if pinned to another repo. |
| `--print` | Dry run. |

Uninstall does not delete `<repo>/.seer/graph.db`; remove `.seer/` yourself if
you want the cache gone.

## Client Files

| Client | Config file | Root key | Guidance |
|---|---|---|---|
| Claude Code | `.mcp.json` or `~/.claude.json` | `mcpServers` | `CLAUDE.md` imports `AGENTS.md` |
| Cursor | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `mcpServers` | `AGENTS.md` |
| VS Code native MCP / Copilot | `.vscode/mcp.json` | `servers` | `AGENTS.md` |
| OpenAI Codex | `.codex/config.toml` or `~/.codex/config.toml` | TOML `mcp_servers` | `AGENTS.md` |
| Gemini CLI | `.gemini/settings.json` or `~/.gemini/settings.json` | `mcpServers` | `GEMINI.md` imports `AGENTS.md` |
| Google Antigravity | `.agents/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json` | `mcpServers` | reads `AGENTS.md`/`GEMINI.md` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | `AGENTS.md` when available |

## Manual Snippets

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

Editor-global JSON clients:

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

Codex TOML:

```toml
[mcp_servers.seer]
command = "npx"
args = ["-y", "seer-mcp", "mcp"]
```

Use `--workspace` whenever the config is user/editor-global.

## Server Options

```bash
npx seer-mcp mcp --workspace <repo> [--db <path>] [--no-watch] [--no-jit]
```

| Flag | Use |
|---|---|
| `--workspace <repo>` | Repo to index. Defaults to current directory. |
| `--db <path>` | Custom SQLite path. |
| `--no-watch` | Disable background watcher. |
| `--no-jit` | Disable per-query freshness check. |

## Troubleshooting

**Agent sees no Seer tools.** Restart/reload the MCP client. Confirm `node` and
`npx` are on the PATH visible to the editor.

**`seer_health` points at the editor install directory.** Run:

```bash
npx seer-mcp update --global
```

If the entry is pinned to another repo, rerun install from the repo:

```bash
npx seer-mcp init --auto --force
```

**First query is slow.** That is the initial index. Pre-index with:

```bash
npx seer-mcp index .
```

**Wrong repo from a global editor config.** Global configs can point to only one
repo per `seer` entry. Run `init --auto --force` from the repo you want active,
or prefer repo-local configs where the client supports them.
