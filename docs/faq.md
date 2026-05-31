# FAQ and positioning

## Is Seer just another codebase-graph MCP?

There is overlap, but the focus is different. Most graph tools help an agent
*explore* structure. Seer is built around the moment *before an edit*: it folds
callers, tests, risk, boundaries, and per-symbol history into one packet so the
agent understands the impact of a change, not just the shape of the code. The
headline differentiator is symbol-level git history, not file-level churn.

## How is Seer different from codebase-memory?

Codebase-memory and similar graph-first tools are great at structural
exploration. Seer leans into edit-awareness: tests that cover a symbol, the risk
of touching it, what a diff will break, and how a function changed over time.
Think of structural exploration as the floor, and edit-impact context as the
thing Seer adds on top.

## How is Seer different from Serena?

Serena-style tools focus on editing and refactoring symbols directly. Seer does
not edit your code. It tells the agent doing the editing what the change is going
to affect, so the edit is safer. They are complementary.

## Does Seer replace Claude, Cursor, or Codex?

No. Seer is an MCP server those tools call. It gives the agent better context;
the agent still does the reasoning and the editing. Seer works with all of them
at once (see [MCP Setup](mcp.md)).

## How is Seer different from grep?

Grep matches text. Seer understands structure. "Who calls this method", "which
tests cover it", "what does this diff break", and "how did this function change"
are not text queries. They also cost far fewer tokens than the multi-search,
multi-file-read dance an agent does with grep alone. Use grep for comments,
string literals, and config values; use Seer for everything structural.

## Does anything leave my machine?

No. Seer-Core is local and deterministic. No API keys, no network calls, no
telemetry. The index is a single SQLite file under `.seer/`.

## Does it use an LLM?

Seer-Core does not. It returns deterministic structural facts. The accuracy and
token-efficiency benchmarks use LLMs only to *measure* how much Seer helps an
agent, not inside Seer itself. (A separate Seer-Onboarding layer is the
LLM-enabled, human-facing product; this repo is Core.)

## Which languages are supported?

Python, JavaScript, TypeScript/TSX, Go, Java, Rust, C, C++, and C#. See
[Language Support](languages.md) for the capability matrix.

## How big a repo can it handle?

It has been run on the Linux kernel and Unreal Engine (millions of symbols, tens
of millions of edges). See [Benchmarks](benchmarks.md) for measured numbers.

## Do I have to commit the `.seer/` folder?

No. It rebuilds on demand. Add `.seer/` to `.gitignore` if you prefer. For
sharing a prebuilt index (for example in CI), use `seer bundle export`.

## How do I keep results fresh?

You do not have to do anything. A background watcher keeps the index warm, and a
hash-based freshness check re-parses anything that changed before a query
returns. If you ever suspect drift, `seer index . --reset` rebuilds clean.
