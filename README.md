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

Run from the repo you want Seer to index. Requires Node.js 24+ on Windows,
macOS, or Linux. Seer is designed to be as easy to install as possible.

```bash
npx seer-mcp init --auto
```

From another directory, pass the repo path:

```bash
npx seer-mcp init C:\path\to\repo --auto
```

Use this when you want Seer set up for the current repo. It writes
workspace-local MCP config only. If you have Project A and Project B, run the
same command in each repo; both keep their own Seer config and index.
Antigravity's repo-local config includes `--workspace` because the IDE can
launch MCP from the Antigravity install directory. Its server id is also
workspace-specific, such as `seer_godot_a1b2c3d4`, so two Antigravity projects
do not fight over one cached `seer` process.

Common installs:

```bash
npx seer-mcp init --auto                 # recommended
npx seer-mcp init                        # same workspace-local default
npx seer-mcp init --client antigravity   # Antigravity IDE / CLI
npx seer-mcp init --client claude        # Claude Code CLI
npx seer-mcp init --client windsurf      # Windsurf user config, pinned here
npx seer-mcp init --client codex         # Codex only
npx seer-mcp init --client all           # all clients; also writes Windsurf user config
```

Useful flags:

- `--auto`: workspace-local setup; no global editor files.
- `--client <name>`: target one client. `all` includes user-level clients such as Windsurf.
- `--global`: write user-level config for clients that support it.
- `--print`: preview files before writing.
- `--force`: replace an existing `seer` / `seer_<workspace>` entry.

Build the local index now:

```bash
npx seer-mcp index .
```

Then restart/reload your agent and ask it to call:

```text
seer_health
```

The index lives at `<repo>/.seer/graph.db`. Add `.seer/` to `.gitignore` if
it is not already ignored. If you skip `index .`, Seer builds the index on the
first query.
Claude Code gets Seer's core MCP tools marked as always-load. Antigravity has
no eager flag; Seer relies on workspace-local config, `--workspace`/`cwd`, and
standard MCP read-only annotations for query tools.

Update existing installs:

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

