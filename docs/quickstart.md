# Quick Start

Seer is a local MCP server for one repo at a time. Run setup from the repo you
want your agent to understand.

Requirements: Node.js 24+ on Windows, macOS, or Linux.

Seer supports both editor and CLI agents. Claude Code CLI uses the Claude
project MCP file. Antigravity CLI uses its Antigravity CLI MCP file. Codex CLI,
Gemini CLI, Cursor, VS Code, Antigravity IDE, and Windsurf use the files shown
below.

## Install

Recommended:

```bash
npx seer-mcp init --auto
```

From another directory:

```bash
npx seer-mcp init C:\path\to\repo --auto
```

This writes repo-local config for clients that support it and detected
editor-wide config for clients such as Antigravity. Editor-wide config is
pinned to the current repo with `--workspace`.

Use a narrower command when you know the client:

| You use | Command |
|---|---|
| Antigravity IDE / CLI | `npx seer-mcp init --client antigravity` |
| Claude Code CLI | `npx seer-mcp init --client claude` |
| Cursor | `npx seer-mcp init --client cursor` |
| VS Code native MCP / Copilot | `npx seer-mcp init --client vscode` |
| OpenAI Codex CLI / extension | `npx seer-mcp init --client codex` |
| Gemini CLI | `npx seer-mcp init --client gemini` |
| Windsurf | `npx seer-mcp init --client windsurf` |
| Everything supported | `npx seer-mcp init --client all` |
| Repo-local defaults only | `npx seer-mcp init` |

Use `--force` if you intentionally want to replace an existing `seer` entry.

## Verify

Restart or reload your agent, then ask it to call:

```text
seer_health
```

The `workspace`/`DB path` should point at the repo you installed from, not at
your editor install directory.

Terminal check:

```bash
npx seer-mcp index .
npx seer-mcp health
npx seer-mcp symbols runInit --top 5
```

## Where Seer Stores Data

Seer creates:

```text
<repo>/.seer/graph.db
```

This is the local SQLite index. Do not commit it. Add this if needed:

```gitignore
.seer/
```

If a repo contains huge local scratch folders, add a `.seerignore`:

```gitignore
Large Codebases/**
Resources/**
.stress/**
```

## What Install Changes

`init` may write these repo files:

| Client | Repo file |
|---|---|
| Claude Code CLI | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| VS Code native MCP / Copilot | `.vscode/mcp.json` |
| Codex | `.codex/config.toml` |
| Gemini | `.gemini/settings.json` |
| Antigravity workspace | `.agents/mcp_config.json` |
| Agent instructions | `AGENTS.md` |
| Claude instruction shim | `CLAUDE.md` |
| Gemini instruction shim | `GEMINI.md` |

`CLAUDE.md` and `GEMINI.md` are small imports to `AGENTS.md`; Seer does not
duplicate the full instruction block there.

For editor-wide clients, `init` may also write user config:

| Client | User-level file |
|---|---|
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |
| Antigravity CLI | `~/.gemini/antigravity-cli/mcp_config.json` |
| Antigravity compatibility paths | `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-ide/mcp_config.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

Editor-wide files include `--workspace <repo>`.

## Workspace-Specific Behavior

Repo-local config follows the repo. If your agent opens a different repo, that
repo needs its own install.

Editor-wide config, such as Antigravity and Windsurf, lives in your user
profile. It can only have one `seer` entry, so it points to one repo at a time.
To move that editor-wide `seer` entry to another repo, run from the new repo:

```bash
npx seer-mcp init --auto --force
```

## Update

Use this after upgrading Seer or after an older install:

```bash
npx seer-mcp update
```

`update` changes:

- Existing Seer MCP entries for this repo.
- The managed Seer block in `AGENTS.md`.
- The `CLAUDE.md` / `GEMINI.md` import shims if present.

`update` does not install brand-new clients. Use `init --auto` or
`init --client <name>` for that.

Useful update flags:

| Flag | Use |
|---|---|
| `--client all` | Refresh all known client entries that already exist. |
| `--global` | Only refresh user-level configs. |
| `--force` | Re-point an editor-wide Seer entry pinned to another repo. |
| `--print` | Show the plan without writing files. |

## Uninstall

Remove Seer from the current repo/configs:

```bash
npx seer-mcp uninstall
```

Uninstall changes:

- Removes `seer` from MCP config files.
- Removes Seer's managed block from `AGENTS.md`.
- Removes Seer's `CLAUDE.md` / `GEMINI.md` block.
- Deletes a config file if it only contained Seer.
- Preserves non-Seer content in the same files.

Uninstall does not delete `<repo>/.seer/graph.db`. Delete `.seer/` yourself if
you want the cache gone.

Useful uninstall flags:

| Flag | Use |
|---|---|
| `--client antigravity` | Remove only one client. |
| `--global` | Only remove user-level config entries. |
| `--no-agents` | Leave `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` alone. |
| `--force` | Remove editor-wide entries even if pinned to another repo. |
| `--print` | Dry run. |

## Common Fixes

Wrong workspace in `seer_health`:

```bash
npx seer-mcp init --auto --force
```

First query is slow:

```bash
npx seer-mcp index .
```

Need to see exactly what would change:

```bash
npx seer-mcp init --auto --print
```
