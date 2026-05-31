<div align="center">

# Seer

Give your AI agents a map of your repo before they edit.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![MCP](https://img.shields.io/badge/MCP-Enabled-brightgreen.svg)](docs/mcp.md)
[![NodeJS](https://img.shields.io/badge/Node.js-%3E%3D_24-green.svg?logo=nodedotjs)](https://nodejs.org/)
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

One command, from inside the repo you want indexed (needs Node 24+):

```bash
npx seer-mcp init
```

### Standard Init vs. Specific Clients
* **Standard Init (`npx seer-mcp init`)**: Configures all standard project-local clients. It automatically writes local workspace configurations for **Claude Code** (`.mcp.json`), **OpenAI Codex** (`.codex/config.toml`), **Gemini CLI** (`.gemini/settings.json`), **VS Code** (`.vscode/mcp.json`), and **Cursor** (`.cursor/mcp.json`).
* **With Google Antigravity & Extensions (`npx seer-mcp init --client claude,codex,gemini,antigravity`)**: If you use the Google Antigravity IDE with the Standard Gemini features alongside the Claude and Codex extensions, targeting these clients explicitly configures all of them at once. It writes to your user-level Antigravity settings (`~/.gemini/antigravity-ide/mcp_config.json`) and drops local workspace configurations for Claude Code (`.mcp.json`), Codex (`.codex/config.toml`), and Gemini (`.gemini/settings.json`).

Reload your agent/extensions and you are connected. (Want to confirm it? Ask the agent to call `seer_health`.)

There is nothing else to run. Seer installs nothing native, and it indexes the
workspace automatically on the first query, so there is no build or index step
to do yourself. On a very large repo that first index can take a couple of
minutes; after that it is cached and you never wait on it again.

> [!TIP]
> **Optional Pre-indexing:** If you are working on a very large repository and want to avoid any first-query latency from your agent, you can pre-index your workspace manually in your terminal before launching the agent:
> ```bash
> npx seer-mcp index .
> ```

Want user-level config or to paste config by hand? Read the [MCP Setup](docs/mcp.md) guide.

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

