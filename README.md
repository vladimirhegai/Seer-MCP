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

That writes the MCP config for whatever agents you use (Claude Code, Cursor,
VS Code, Codex, Gemini) and drops an `AGENTS.md` so they actually know Seer
exists. Reload your agent and you are connected. (Want to confirm it? Ask the
agent to call `seer_health`.)

There is nothing else to run. Seer installs nothing native, and it indexes the
workspace automatically on the first query, so there is no build or index step
to do yourself. On a very large repo that first index can take a couple of
minutes; after that it is cached and you never wait on it again.

Want Antigravity too, or the user-level config, or to paste the snippet by hand?
Antigravity is one flag away (`npx seer-mcp init --client all`), and every
client's exact config is in [MCP Setup](docs/mcp.md).

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

