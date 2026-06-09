# MCP Setup

This is the config reference for connecting Seer to an MCP client. Most users
should start with the wizard:

```bash
npx seer-mcp init
```

After setup, reload the agent and call:

```text
seer_health
```

The reported `workspace` should be the repo you installed from.

## Client Commands

| Client | Command |
|---|---|
| Auto-detected client | `npx seer-mcp init --yes` |
| Antigravity IDE / CLI | `npx seer-mcp init --client antigravity` |
| Claude Code | `npx seer-mcp init --client claude` |
| Cursor | `npx seer-mcp init --client cursor` |
| VS Code MCP / Copilot | `npx seer-mcp init --client vscode` |
| Codex CLI / extension | `npx seer-mcp init --client codex` |
| Gemini CLI | `npx seer-mcp init --client gemini` |
| Windsurf | `npx seer-mcp init --client windsurf` |
| All supported clients | `npx seer-mcp init --client all` |

Flags used often:

| Flag | Meaning |
|---|---|
| `--print` | Show the files that would change. |
| `--force` | Replace the existing Seer entry. |
| `--global` | Write user-level config. |
| `--no-agents` | Leave instruction files alone. |

All setup commands accept an optional workspace path:

```bash
npx seer-mcp init C:\path\to\repo
```

## Workspace Rule

Seer indexes one repo at a time. Repo-local MCP config can run:

```bash
npx -y seer-mcp mcp
```

User-level config should pin the repo:

```bash
npx -y seer-mcp mcp --workspace C:/path/to/repo
```

Antigravity also gets a repo-specific server id, such as
`seer_godot_a1b2c3d4`, so each project gets a separate cached MCP process.

## Files By Client

| Client | Config file | Scope |
|---|---|---|
| Claude Code | `.mcp.json` | repo |
| Cursor | `.cursor/mcp.json` | repo |
| VS Code MCP / Copilot | `.vscode/mcp.json` | repo |
| Codex | `.codex/config.toml` | repo |
| Gemini CLI | `.gemini/settings.json` | repo |
| Antigravity workspace | `.agents/mcp_config.json` | repo, pinned |
| Antigravity global fallback | `~/.gemini/antigravity/mcp_config.json` | user, pinned |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | user, pinned |

Instruction files:

| File | Purpose |
|---|---|
| `AGENTS.md` | Main Seer guidance block for agents. |
| `CLAUDE.md` | Small Claude import shim for `AGENTS.md`. |
| `GEMINI.md` | Small Gemini/Antigravity import shim for `AGENTS.md`. |

Seer treats these as shared user files, not owned files. On install it appends
or refreshes only the managed region fenced by `<!-- seer:begin -->` and
`<!-- seer:end -->`; any existing project instructions before or after that
region are preserved. On uninstall it strips only complete Seer-managed regions.
If a file has unmatched, nested, or out-of-order Seer markers, Seer reports the
file as manual and leaves it unchanged so it cannot accidentally remove user
workflow instructions.

The same merge rule applies to MCP config files: existing servers are
preserved, only the Seer server entry is added, refreshed, or removed. If a
config file cannot be parsed safely, Seer prints a manual snippet rather than
rewriting the file.

## Build The Index

```bash
npx seer-mcp index .
```

If the index is missing, Seer builds `<repo>/.seer/graph.db` on the first MCP
query.

## Tool Loading

MCP clients decide how tools appear in the UI. Seer gives each tool standard
read-only metadata where appropriate, then lets the client handle display.

| Client | Behavior |
|---|---|
| Antigravity | Workspace-local config, pinned workspace, repo-specific server id. |
| Claude Code | Core tools include `_meta["anthropic/alwaysLoad"]`; specialist tools stay discoverable. |
| Codex, Cursor, VS Code, Gemini, Windsurf | Standard MCP config and tool annotations. |

## Manual Config Snippets

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

User-level JSON clients:

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

Add `--workspace <repo>` to `args` for user-level config.

## History Tools

`seer_history` can build history for the queried symbol's file on first use.
The full repo history index is explicit because it can take time:

```bash
npx seer-mcp symbol-history --workspace C:/path/to/repo
```

Agents should ask before starting a full history build.

## Update And Uninstall

```bash
npx seer-mcp update
npx seer-mcp uninstall
```

| Command | What it changes |
|---|---|
| `update` | Refreshes existing Seer MCP entries and managed instruction blocks. |
| `uninstall` | Removes Seer MCP entries and managed instruction blocks. |

Useful uninstall flags:

| Flag | Use |
|---|---|
| `--client <name>` | Remove one client. |
| `--global` | Remove user-level entries. |
| `--remove-db` | Also delete `.seer/`. |
| `--print` | Dry run. |

## Terminal Check

```bash
npx seer-mcp index .
npx seer-mcp health
npx seer-mcp symbols runInit --top 5
```
