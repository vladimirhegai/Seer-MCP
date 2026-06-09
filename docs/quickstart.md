# Quick Start

Seer is a local MCP server for one repository at a time. Run setup from the repo
you want your agent to understand.

**Requirement:** Node.js 24+ on Windows, macOS, or Linux.

## 1. Install

```bash
npx seer-mcp init
```

The wizard asks a few questions and writes the MCP config for the agent you use.
It can also build the first index right away.

| Prompt | Pick this when |
|---|---|
| Agent/client | Choose the editor or CLI agent you want to connect. |
| Index now | Recommended for the first run. |

From another directory, pass the repo path:

```bash
npx seer-mcp init C:\path\to\repo
```

## 2. Build Or Refresh The Index

If the wizard already indexed the repo, you can skip this.

```bash
npx seer-mcp index .
npx seer-mcp index . --reset
```

Seer stores the index here:

```text
<repo>/.seer/graph.db
```

Add this to `.gitignore` if your repo does not already ignore it:

```gitignore
.seer/
```

## 3. Optional Git History

`seer_history` can build just the queried symbol's file on a cold miss, so most
users can skip the full history pass at setup time.

Build full symbol history when you want repo-wide co-change signals from
`seer_changes_with`:

```bash
npx seer-mcp symbol-history
npx seer-mcp symbol-history --since 1y
```

This can take a while on large repos. Re-running it is incremental.

## 4. Reload Your Agent

Restart or reload the agent, then ask it to call:

```text
seer_health
```

The response should point at the repo you installed from. If it points somewhere
else, rerun setup from the correct repo:

```bash
npx seer-mcp init --yes --force
```

Then reload the agent again.

## Non-Interactive Setup

Use these when scripting setup or when you already know the client.

| You use | Command |
|---|---|
| Detected client, defaults | `npx seer-mcp init --yes` |
| Antigravity IDE or CLI | `npx seer-mcp init --client antigravity` |
| Claude Code | `npx seer-mcp init --client claude` |
| Cursor | `npx seer-mcp init --client cursor` |
| VS Code MCP / Copilot | `npx seer-mcp init --client vscode` |
| Codex CLI / extension | `npx seer-mcp init --client codex` |
| Gemini CLI | `npx seer-mcp init --client gemini` |
| Windsurf | `npx seer-mcp init --client windsurf` |
| Every supported client | `npx seer-mcp init --client all` |

Useful flags:

| Flag | Use |
|---|---|
| `--force` | Replace an existing Seer entry for this repo. |
| `--print` | Preview file changes. |
| `--global` | Write a user-level config when the client needs it. |

## What Setup Writes

Workspace-local setup keeps config near the repo, which makes multi-repo work
less confusing.

| Client | File |
|---|---|
| Claude Code | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| VS Code MCP / Copilot | `.vscode/mcp.json` |
| Codex | `.codex/config.toml` |
| Gemini | `.gemini/settings.json` |
| Antigravity workspace | `.agents/mcp_config.json` |
| Agent guidance | `AGENTS.md` |
| Claude guidance shim | `CLAUDE.md` |
| Gemini guidance shim | `GEMINI.md` |

Some clients use user-level files:

| Client | User-level file |
|---|---|
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Antigravity global fallback | `~/.gemini/antigravity/mcp_config.json` |
| Codex global fallback | `~/.codex/config.toml` |

User-level entries include `--workspace <repo>` so Seer knows which repo to
index.

Seer merges these files instead of replacing them. Existing MCP servers stay in
place, and existing `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` content is
preserved. Seer adds only a fenced block between `<!-- seer:begin -->` and
`<!-- seer:end -->`; uninstall removes only that fenced block. If those markers
are malformed, Seer leaves the instruction file untouched and reports a manual
cleanup note instead of guessing.

## Common Fixes

| Problem | Command |
|---|---|
| Agent sees the wrong repo | `npx seer-mcp init --yes --force` |
| Build the index yourself | `npx seer-mcp index .` |
| Check from a terminal | `npx seer-mcp health` |
| Preview setup changes | `npx seer-mcp init --print` |
| Refresh existing Seer config | `npx seer-mcp update` |
| Remove Seer config | `npx seer-mcp uninstall` |

For a full config reference, see [MCP Setup](mcp.md).
