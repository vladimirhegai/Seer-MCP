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

AI agents are good at writing code. However, they are much worse at knowing _what_ they are about to affect.

Instead of making agents piece together context from repeated searches, Seer compresses callers, tests, routes, service links, boundaries, history (yes, your git history too!), and risk signals, then compresses it into high-signal context agents can actually use *all whilst improving* token usage, speed, and accuracy.

- **Difference from IDE-proxy servers (like Serena)**:
  Seer is less about symbol editing tools, and more about *change understanding*. Before an edit, agents get a clearer picture of impact, ownership, and surrounding behavior.
- **Difference from static indexers (like codebase-memory)**:
  Seer goes beyond searchable graphs toward edit-aware context: behavioral tests, risk signals, continuity across renames/moves, and context packets designed for real agent workflows.

Tested across real repositories and agent workflows, with measurable gains in context quality, speed, and token efficiency (see [Benchmarks](docs/benchmarks.md)).

[pimage]

[benchmark summary block]


---

## Quick Start

[very short install]

[very short MCP setup]

[first successful command]

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

### npm

### from source

### MCP configuration

### CI bundles / prebuilt bundles

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

