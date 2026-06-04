# MCP Setup

This page is the exact MCP configuration reference. For normal use, run setup
from the repo you want Seer to index:

```bash
npx seer-mcp init
```

This launches an interactive wizard that asks which agent(s) to configure and
whether to index now. It writes workspace-local config only — into the current
repo, never into user-level/global MCP files unless you ask for `--global`.
Then restart/reload your agent and ask it to call `seer_health`.

Seer supports Windows, macOS, and Linux. In paths below, `~` means your user
home directory (`%USERPROFILE%` on Windows).

## Pick A Client

The wizard handles client selection for you. To skip it (scripts, CI, or when
you already know the client), use `--yes` or name the client:

| You use | Command |
|---|---|
| Detected client, no prompts | `npx seer-mcp init --yes` |
| Antigravity IDE / CLI | `npx seer-mcp init --client antigravity` |
| Claude Code CLI | `npx seer-mcp init --client claude` |
| Cursor | `npx seer-mcp init --client cursor` |
| VS Code native MCP / Copilot | `npx seer-mcp init --client vscode` |
| Codex CLI / extension | `npx seer-mcp init --client codex` |
| Gemini CLI | `npx seer-mcp init --client gemini` |
| Windsurf user config | `npx seer-mcp init --client windsurf` |
| Everything supported, including Windsurf user config | `npx seer-mcp init --client all` |

Use `--print` to preview changes and `--force` to replace an existing `seer`
entry. `--client` and `--yes` both skip the wizard. `--client all` includes
user-level-only clients such as Windsurf.

All `init`, `update`, and `uninstall` commands accept an optional workspace path:

```bash
npx seer-mcp init C:\path\to\repo
```

## Workspace Rule

Seer indexes one workspace at a time.

Workspace-local config starts Seer from the repo, so it can use:

```bash
npx -y seer-mcp mcp
```

User-level config may start from the editor install directory, so it must pin
the repo:

```bash
npx -y seer-mcp mcp --workspace C:/path/to/repo
```

Antigravity workspace config also includes `--workspace` and `cwd` because the
IDE may launch MCP from its own install directory. Seer also gives Antigravity a
repo-specific server id such as `seer_godot_a1b2c3d4`; this prevents Project A
and Project B from sharing one cached `seer` process.

If `seer_health` shows your editor directory or another repo instead of the
active repo, the agent is using a stale/mispointed MCP process. Rerun setup from
the repo:

```bash
npx seer-mcp init --yes --force
```

Then restart/reload the agent. Do not trust Seer query results until
`seer_health.workspace` is the active repo.

Project A and Project B can both have Seer when each repo has its own local MCP
file. For Antigravity, that file is `.agents/mcp_config.json`.

## Build The Index

Run this from the repo before starting the agent:

```bash
npx seer-mcp index .
```

If you skip this, Seer builds `<repo>/.seer/graph.db` on the first MCP query.

## Tool Loading

MCP clients decide whether tools are visible immediately or discovered on
demand. Seer marks query/navigation tools with standard MCP read-only
annotations, marks maintenance/build tools as not read-only, and does not write
undocumented eager flags.

| Client | Seer behavior |
|---|---|
| Antigravity IDE / CLI | No eager flag. Seer uses workspace-local config, `--workspace`, `cwd`, repo-specific server ids, agent instructions, and MCP read-only annotations. |
| Claude Code CLI | Seer marks core tools with `_meta["anthropic/alwaysLoad"]`; large/specialist tools remain on demand. |
| Codex CLI / extension | Seer writes supported MCP config and standard MCP read-only annotations. No verified Codex eager/always-load setting. |
| Cursor / VS Code / Gemini / Windsurf | Seer writes supported MCP config. Use client allow/disable controls if available. |

## History Tools

`seer_history` auto-builds just the queried symbol's file inline on a cold miss
(bounded, ~1s) and returns its commits — so a single-symbol question needs no
separate step. Pass `autoBuild: false` for a strictly read-only lookup.

The expensive part is the FULL repo history index. That stays explicit — build
it for the whole repo with:

```bash
npx seer-mcp symbol-history --workspace C:/path/to/repo
```

Or ask the MCP tool (`seer_symbol_history_build`, no `symbols`/`paths`) for a
bounded pass:

```json
{ "maxSeconds": 60, "maxFiles": 200 }
```

Agents should ask before starting a FULL history build. For very large repos,
prefer the shell command so the agent session is not tied up by git history
walking.

## Files By Client

| Client | Config file | MCP key | Scope |
|---|---|---|---|
| Claude Code CLI | `.mcp.json` | `mcpServers.seer` | repo |
| Cursor | `.cursor/mcp.json` | `mcpServers.seer` | repo |
| VS Code native MCP / Copilot | `.vscode/mcp.json` | `servers.seer` | repo |
| Codex | `.codex/config.toml` | `mcp_servers.seer` | repo |
| Gemini CLI | `.gemini/settings.json` | `mcpServers.seer` | repo |
| Antigravity workspace | `.agents/mcp_config.json` | `mcpServers.seer_<repo>_<hash>` | repo, pinned |
| Antigravity user with `--global` | `~/.gemini/antigravity/mcp_config.json` | `mcpServers.seer_<repo>_<hash>` | user |
| Antigravity compatibility with `--global` | `~/.gemini/antigravity-cli/mcp_config.json`, `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-ide/mcp_config.json` | `mcpServers.seer_<repo>_<hash>` | user |
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

Antigravity workspace JSON:

```json
{
  "mcpServers": {
    "seer_myrepo_a1b2c3d4": {
      "command": "npx",
      "args": ["-y", "seer-mcp", "mcp", "--workspace", "C:/path/to/repo"],
      "cwd": "C:/path/to/repo"
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

Add `--workspace <repo>` to `args` whenever the config is user-level. Do not
add it to repo-local config unless the client requires it. Antigravity requires
it.

Codex fallback:

```bash
npx seer-mcp init --client codex --global --force
```

Use this only if your Codex install does not load the repo-local
`.codex/config.toml`. The fallback writes `~/.codex/config.toml` and pins the
current repo with `--workspace`.

Antigravity IDE fallback:

```bash
npx seer-mcp init --client antigravity --global --force
```

Use this only if Antigravity IDE does not load `.agents/mcp_config.json` after a
reload. The fallback writes Antigravity's user-level MCP file and pins the
current repo with `--workspace`, `cwd`, and a repo-specific server id. Prefer
workspace-local setup so unrelated repos do not see each other's Seer servers.

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
| `--client all` | Refresh all known clients that already have Seer entries, including user-level Windsurf when present. |
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

`--global` does not touch repo guidance files.

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
