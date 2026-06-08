# FAQ

## What is Seer?

Seer is a local MCP server that shows AI coding agents what an edit will touch:
symbols, callers, tests, routes, service links, boundaries, history, and edit
risk.

## Does Anything Leave My Machine?

No. Seer-Core runs locally, writes a local SQLite index, and makes no network
calls for indexing or querying.

```text
<repo>/.seer/graph.db
```

## Does Seer Use An LLM?

Seer-Core returns deterministic structural facts. Agents can use those facts,
while Core itself makes no LLM calls.

## What Problems Is It Good At?

| Question | Seer tool |
|---|---|
| Who calls this method? | `seer_callers` |
| What does this function call? | `seer_callees` |
| What should I know before editing this symbol? | `seer_preflight` |
| Which tests exercise this code? | `seer_behavior` |
| What changed in this diff? | `seer_preflight` with `fromRef` / `toRef` |
| Which service handler receives this call? | `seer_service_links` |
| How has this symbol changed over time? | `seer_history` |

## How Is It Different From Text Search?

Text search finds matching strings. Seer finds code structure. Use search for
comments, literals, and config text. Use Seer for callers, callees, route maps,
test reachability, and edit impact.

## Does It Edit Code?

Seer gives context to the agent doing the editing. It keeps its own tools
read-only except for maintenance tasks such as indexing and setup.

## Which Agents Can Use It?

Seer connects through MCP. The setup wizard supports:

| Client | Setup |
|---|---|
| Claude Code | `npx seer-mcp init --client claude` |
| Cursor | `npx seer-mcp init --client cursor` |
| VS Code MCP / Copilot | `npx seer-mcp init --client vscode` |
| Codex | `npx seer-mcp init --client codex` |
| Gemini | `npx seer-mcp init --client gemini` |
| Antigravity | `npx seer-mcp init --client antigravity` |
| Windsurf | `npx seer-mcp init --client windsurf` |

## Which Languages Are Supported?

Python, JavaScript, TypeScript/TSX, Go, Java, Rust, C, C++, and C#. See
[Language Support](languages.md) for details.

## How Big A Repo Can It Handle?

Seer has been tested on repos such as Godot, TypeScript, React, the Linux
kernel, and Unreal Engine. See [Benchmarks](benchmarks.md) for indexing numbers.

## Do I Commit `.seer/`?

No. The index rebuilds on demand. Add this to `.gitignore`:

```gitignore
.seer/
```

For sharing an index across machines or repos, use bundles:

```bash
seer bundle export --out repo.seerbundle
seer bundle import repo.seerbundle --external --alias upstream
```

## How Does Freshness Work?

Seer watches the workspace and also checks file hashes before queries. Changed
files are re-indexed before results return.

If you ever want a clean rebuild:

```bash
seer index . --reset
```
