<div align="center">

# Seer

Give your AI agents a map of your repo before they edit.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![MCP](https://img.shields.io/badge/MCP-Enabled-brightgreen.svg)](docs/mcp.md)
[![NodeJS](https://img.shields.io/badge/Node.js-%3E%3D_18-green.svg?logo=nodedotjs)](https://nodejs.org/)
[![CI](https://img.shields.io/badge/CI-passing-brightgreen.svg)](https://github.com/vladimirhegai/Seer-Core/actions)
<br/><br/>
[![Benchmarks](https://img.shields.io/badge/Benchmarks-View_Report-green?style=for-the-badge)](docs/benchmarks.md)
[![Testing](https://img.shields.io/badge/Testing-View_Specs-brightgreen?style=for-the-badge)](docs/testing.md)

</div>

AI agents are good at writing code. However, they are much worse at knowing **what** they are about to affect.

Instead of making agents piece together context from repeated searches, Seer compresses callers, tests, routes, service links, boundaries, risk signals, and yes, **even your git history**, into context agents can actually use all whilst **<u>improving</u>** token usage, speed, and accuracy.

Oh, and Seer can absolutely help agents find their way inside large, messy repositories. Using signals like **call graphs**, **Louvain-style module clustering**, **service links**, and **symbol history**, agents can orient toward the right subsystem before they touch code.


- **Difference from IDE-style agent tools (e.g. Serena):**  
  Seer focuses less on editing symbols and refactoring code, and more on helping agents understand the impact of a change before they make it.

- **Difference from graph-first codebase tools (e.g. Codebase-Memory):**  
  Graph-first tools help agents explore structure. Seer focuses on edit-aware context: tests, risk, history, and change impact.

*Tested across real repositories and agent workflows, with measurable gains in context quality, speed, and token efficiency (see [Benchmarks](docs/benchmarks.md)).*

[pimage]

[benchmark summary block]


---

## Quick Start

```bash
# 1. Get the engine (Node 18+; 26+ recommended)
git clone https://github.com/vladimirhegai/Seer-Core.git
cd Seer-Core && npm install && npm run build

# 2. Wire it into your AI agents, from inside the repo you want indexed
seer init        # writes MCP config for Claude Code, Cursor, VS Code, Codex, Gemini
                 # and drops an AGENTS.md so the agent knows Seer exists

# 3. Reload your agent and ask it to call seer_health
```

Seer indexes the workspace automatically on the first query, so there is no
separate build step. Prefer to paste the config yourself, or use Codex /
Antigravity? Every client's snippet is in [MCP Setup](docs/mcp.md).

→ [Full Quick Start](docs/quickstart.md)

---

## Docs

- [Quick Start](docs/quickstart.md)
- [MCP Setup](docs/mcp.md)
- [Tool Guide](docs/tools.md)
- [CLI Reference](docs/cli.md)
- [Examples](docs/examples.md)
- [Benchmarks](docs/benchmarks.md)
- [Architecture](docs/architecture.md)
- [Known Limits](docs/limits.md)

---

## Why Seer Exists

[problem framing]

[pimage]

---

## What Agents Can Ask Seer

### Before editing unfamiliar code

[pimage]

→ [Example Workflow](docs/examples/pre-edit-context.md)

### Find connected tests

[pimage]

→ [Behavior / Test Examples](docs/examples/behavior-tests.md)

### Follow routes and service boundaries

[pimage]

→ [Service Links Guide](docs/examples/service-links.md)

### Understand recent changes

[pimage]

→ [History / Change Context Examples](docs/examples/change-history.md)

---

## Benchmarks

[pimage]

[small summary table]

→ [Benchmark Summary](docs/benchmarks.md)

→ [Methodology](docs/benchmarks/methodology.md)

→ [Raw Results](docs/benchmarks/raw-results.md)

---

## FAQ

### Is Seer another codebase graph MCP?

### How is Seer different from codebase-memory?

### How is Seer different from Serena?

### Does Seer replace Claude / Cursor / Codex?

### How is Seer different from grep?

→ [Expanded FAQ / Positioning Notes](docs/faq.md)

---

## Installation

Seer is a local MCP server with zero native dependencies, so install is mostly
"point your agent at it." The one command that does this for every agent is
`seer init`.

### From source (works today)

```bash
git clone https://github.com/vladimirhegai/Seer-Core.git
cd Seer-Core
npm install
npm run build      # produces dist/cli/index.js
npm link           # optional: puts `seer` on your PATH
```

### From npm (once published)

```bash
npx -y seer-mcp mcp     # no global install, runs anywhere
```

### Connect your agents

From inside the repo you want indexed:

```bash
seer init                      # Claude Code, Cursor, VS Code, Codex, Gemini (project-local)
seer init --client all         # also Antigravity and the user-level configs
seer init --print              # dry run: show the snippets, write nothing
seer init --npx                # emit a portable npx launcher instead of a local path
```

`seer init` is idempotent and merges into existing config files without clobbering
them. It also writes an `AGENTS.md` block so the agent actually reaches for Seer
instead of grepping. Supported clients and their exact config formats:

| Client | Config file | Root key |
|---|---|---|
| Claude Code | `.mcp.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` | `mcpServers` |
| VS Code (Copilot) | `.vscode/mcp.json` | `servers` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.seer]` |
| Gemini CLI | `.gemini/settings.json` | `mcpServers` |
| Antigravity | `~/.gemini/config/mcp_config.json` | `mcpServers` |

### Prebuilt / CI bundles

To share a prebuilt index (for example across a team or in CI), export a portable
bundle and import it elsewhere:

```bash
seer ci bundle                 # fresh-index and emit a .seerbundle (for CI)
seer ci workflow               # print a ready-to-paste GitHub Actions workflow
seer bundle import repo.seerbundle --external --alias upstream
```

→ [Full Installation Guide](docs/quickstart.md)

→ [MCP Configuration](docs/mcp.md)

---

## CLI + MCP Reference

### Core CLI commands

### MCP tools overview

### Common workflows

→ [CLI Reference](docs/cli.md)

→ [Tool Reference](docs/tools.md)

---

## Internals

[pimage]

### Indexing

### Symbol layers

### Service links

### Change context

### Storage / bundles

→ [Architecture](docs/architecture.md)

→ [Implementation Notes](docs/internals.md)

---

## Testing + Validation

### Unit / integration / scale testing

### MCP parity testing

### Benchmark validation

→ [Testing Guide](docs/testing.md)

→ [Benchmarks](docs/benchmarks.md)

---

## Supported Languages

→ [Language Support Matrix](docs/languages.md)

---

## Known Limits

→ [Known Limits](docs/limits.md)

---

## Contributing

→ [CONTRIBUTING.md]

---

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for the full license text.

