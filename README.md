<div align="center">

# Seer

Give your AI agents a map of your repo before they edit.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![MCP](https://img.shields.io/badge/MCP-Enabled-brightgreen.svg)](docs/mcp.md)
[![NodeJS](https://img.shields.io/badge/Node.js-%3E%3D_24-green.svg?logo=nodedotjs)](https://nodejs.org/)
[![CI](https://img.shields.io/badge/CI-passing-brightgreen.svg)](https://github.com/vladimirhegai/Seer-MCP/actions)
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

From the repo you want Seer to understand, run:

```bash
npx seer-mcp init
```

Requires Node.js 24+ on Windows, macOS, or Linux.

That starts a short interactive setup that asks you three things and does the
rest:

1. **Which AI agent** you use (Antigravity, Claude Code, Codex, Cursor, Gemini,
   VS Code, Windsurf) — one agent per repo, so this is a single choice. It
   pre-selects the one it detects, so usually you just press Enter. If you pick
   Antigravity, it also offers to wire up any Claude / Codex / Gemini extensions
   you run inside it.
2. **Index now?** — recommended. Builds the local map so the first agent query
   is instant.
3. **Index git history too?** — optional, off by default (slow on large repos).

It only writes config for the agents you choose — picking Antigravity will
never scribble `.cursor/` or `.vscode/` into your repo.

When you're done, restart/reload your agent and ask it to call `seer_health` to
confirm it's connected.

### Non-interactive / scripted

Skip the prompts with `--yes`, or name the client directly:

```bash
npx seer-mcp init --yes                   # accept detected defaults, no prompts
npx seer-mcp init --client antigravity    # Antigravity IDE / CLI
npx seer-mcp init --client claude         # Claude Code
npx seer-mcp init --client codex          # Codex
npx seer-mcp init --client cursor         # Cursor
npx seer-mcp init --client vscode         # VS Code (Copilot / native MCP)
npx seer-mcp init --client gemini         # Gemini CLI
npx seer-mcp init --client windsurf       # Windsurf (user-level, pinned here)
npx seer-mcp init --client all            # every supported client
```

From another directory, pass the repo path first: `npx seer-mcp init C:\path\to\repo`.

Useful flags:

- `--yes`: skip the wizard; accept the detected client and defaults.
- `--client <name>`: target one client (skips the wizard).
- `--global`: write user-level config for clients that support it.
- `--print`: preview every file change without writing.
- `--force`: replace an existing `seer` / `seer_<workspace>` entry.

### Per-repo by design

Seer maps one repo at a time, so config is workspace-local. Run setup once in
each repo; Project A and Project B each keep their own config and index, with no
re-pointing. Antigravity gets a workspace-specific server id (such as
`seer_godot_a1b2c3d4`) so two projects never share one cached `seer` process.

The index lives at `<repo>/.seer/graph.db` — add `.seer/` to `.gitignore`. If
you skip indexing during setup, Seer builds it on the first query. To rebuild
later, or to install without the wizard, run `npx seer-mcp index .`.

Already installed? Refresh an existing setup after upgrading Seer:

```bash
npx seer-mcp update
```

More detail: [Full Quick Start](docs/quickstart.md) and [MCP Setup](docs/mcp.md).

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

