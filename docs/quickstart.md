# Quick Start

Seer is a local MCP server for one repo at a time. Run setup from the repo you
want your agent to understand.

Requirements: Node.js 24+ on Windows, macOS, or Linux.

Seer supports both editor and CLI agents. The default install is
workspace-specific: run it once per repo you want agents to understand.

## Install

Recommended:

```bash
npx seer-mcp init --auto
```

From another directory:

```bash
npx seer-mcp init C:\path\to\repo --auto
```

This writes workspace-local config only. It does not rewrite Antigravity,
Cursor, Claude, Codex, or Gemini user-level config.

Example:

```bash
cd ProjectA
npx seer-mcp init --auto

cd ../ProjectB
npx seer-mcp init --auto
```

Project A and Project B now both have Seer. No re-pointing is needed when the
agent loads each repo's local MCP config. Antigravity uses a repo-specific MCP
server id, such as `seer_godot_a1b2c3d4`, so two projects do not share one
cached `seer` process.

Use a narrower command when you know the client:

| You use | Command |
|---|---|
| Antigravity IDE / CLI | `npx seer-mcp init --client antigravity` |
| Claude Code CLI | `npx seer-mcp init --client claude` |
| Cursor | `npx seer-mcp init --client cursor` |
| VS Code native MCP / Copilot | `npx seer-mcp init --client vscode` |
| OpenAI Codex CLI / extension | `npx seer-mcp init --client codex` |
| Gemini CLI | `npx seer-mcp init --client gemini` |
| Windsurf user config | `npx seer-mcp init --client windsurf` |
| Everything supported, including Windsurf user config | `npx seer-mcp init --client all` |
| Workspace-local defaults only | `npx seer-mcp init` |

Use `--force` if you intentionally want to replace an existing `seer` /
`seer_<workspace>` entry.

`--client all` includes user-level-only clients such as Windsurf. Use `--auto`
when you want the workspace-local default set only.

Use `--global` only when you want Seer in a user-level config file:

```bash
npx seer-mcp init --client antigravity --global --force
```

Global/user-level entries include `--workspace <repo>` because they do not
belong to one project folder. For Antigravity, prefer the workspace-local
command first; the global fallback can expose multiple repo-specific Seer
servers to every Antigravity workspace.

## Build And Verify

Build the index from the repo before starting the agent:

```bash
npx seer-mcp index .
```

If you skip this, Seer builds `<repo>/.seer/graph.db` on the first MCP query.

Restart or reload your agent, then ask it to call:

```text
seer_health
```

The `workspace`/`DB path` should point at the repo you installed from, not at
your editor install directory or another repo. If it is wrong, the active MCP
process is stale or loaded from a different workspace; restart/reload the agent
after rerunning setup.

Terminal check:

```bash
npx seer-mcp health
npx seer-mcp symbols runInit --top 5
```

## Tool Loading

Seer writes client config, but the client decides how MCP tools are loaded.
Seer marks query/navigation tools with standard MCP read-only annotations and
marks maintenance/build tools as not read-only.

- Antigravity: no eager flag. Seer keeps the setup workspace-local, pins
  `--workspace`/`cwd`, writes strong agent instructions, and advertises
  read-only tool metadata.
- Claude Code: Seer marks the core tools as `anthropic/alwaysLoad`; larger
  specialist tools stay discoverable on demand.
- Codex, Cursor, VS Code, Gemini, Windsurf: Seer writes the supported MCP
  config shape and standard MCP tool annotations, then relies on the client to
  expose tools after reload.

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

For user-level clients, `init --global` or a user-level-only client may write:

| Client | User-level file |
|---|---|
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |
| Antigravity CLI | `~/.gemini/antigravity-cli/mcp_config.json` |
| Antigravity compatibility paths | `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-ide/mcp_config.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

User-level files include `--workspace <repo>`.

## Workspace-Specific Behavior

Workspace-local config follows the repo. If your agent opens a different repo,
that repo needs its own install.

This is the normal flow for:

| Client | Default Seer scope |
|---|---|
| Antigravity IDE / CLI | Workspace-local `.agents/mcp_config.json`, pinned with `--workspace`, `cwd`, and a repo-specific server id |
| Claude Code CLI | Workspace-local `.mcp.json` |
| Cursor | Workspace-local `.cursor/mcp.json` |
| VS Code native MCP / Copilot | Workspace-local `.vscode/mcp.json` |
| Codex CLI / extension | Workspace-local `.codex/config.toml` |
| Gemini CLI | Workspace-local `.gemini/settings.json` |
| Windsurf | User-level only, pinned with `--workspace` |

Windsurf is the exception because its documented MCP file is user-level. Seer
pins that entry to the repo you installed from:

```bash
npx seer-mcp init --client windsurf --force
```

If a user-level entry points to the wrong repo, `seer_health` will show it.
Re-run the explicit command from the repo you want active.

Antigravity's config is still stored in the repo, but Seer pins `--workspace`
and `cwd` inside that file because the IDE can launch MCP from the Antigravity
install directory instead of the repo. The server key is repo-specific
(`seer_<repo>_<hash>`) so Antigravity does not reuse Project A's Seer process
inside Project B.

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
| `--client all` | Refresh all known client entries that already exist, including user-level Windsurf when present. |
| `--global` | Only refresh user-level configs. |
| `--force` | Re-point a user-level Seer entry pinned to another repo. |
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
| `--force` | Remove user-level entries even if pinned to another repo. |
| `--print` | Dry run. |

`--global` does not touch repo guidance files.

## Common Fixes

### Wrong Workspace

```bash
npx seer-mcp init --auto --force
```

Then restart/reload the agent. If `seer_health` still reports another repo, the
agent is still using an old MCP process.

### Noisy Callers

```bash
npx seer-mcp callers Node.add_child --file scene/main/node.cpp
```

In MCP, pass the same `file` field to `seer_callers` or `seer_trace` callers.
For large transitive graphs, ask for a summary or page:

```json
{"scope":"callers","args":{"symbol":"Node.add_child","file":"scene/main/node.cpp","mode":"summary"}}
```

```json
{"scope":"callers","args":{"symbol":"Node.add_child","file":"scene/main/node.cpp","limit":20,"offset":20}}
```

### Build Or Rebuild The Index

Run this yourself before opening an agent, or after changing many files:

```bash
npx seer-mcp index .
```

### Preview Changes

```bash
npx seer-mcp init --auto --print
```

### Codex Does Not Show Seer

```bash
npx seer-mcp init --client codex --global --force
```

Some Codex versions only load project-local `.codex/config.toml` for trusted
projects. The global fallback uses `~/.codex/config.toml`.

### Antigravity IDE Does Not Show Seer

```bash
npx seer-mcp init --client antigravity --global --force
```

This writes Antigravity's user-level MCP file and pins it to the current repo
with `--workspace`, `cwd`, and a repo-specific server id. Prefer
workspace-local setup unless the IDE is definitely not loading
`.agents/mcp_config.json`.
