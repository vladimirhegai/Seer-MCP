# Quick Start

Seer is a local MCP server. You point it at a repo, it builds a small SQLite
index, and your AI agent can then ask it structural questions instead of
grepping around. This page gets you from zero to a connected agent.

There is no account, no API key, and nothing leaves your machine.

---

## 1. Install

You need Node.js 18 or newer (Node 26+ recommended).

### From source (works today)

```bash
git clone https://github.com/vladimirhegai/Seer-Core.git
cd Seer-Core
npm install
npm run build
```

That produces the runnable CLI at `dist/cli/index.js`. If you want a global
`seer` command, link it:

```bash
npm link        # now `seer` is on your PATH
```

### From npm

Once published, the whole thing collapses to one line that every agent can run
without a global install:

```bash
npx -y seer-core mcp
```

---

## 2. Connect your agent (the easy way)

Run `seer init` inside the repo you want indexed. It detects nothing magical;
it just writes the right MCP config snippet to the right file for each agent,
and drops an `AGENTS.md` so the agent knows the tool exists and how to use it.

```bash
seer init
```

By default it configures the clients that support a project-local config file
(Claude Code, Cursor, VS Code, Codex, Gemini) and leaves a shareable, committable
config in your repo. Want everything, including the user-level ones?

```bash
seer init --client all
```

Pick specific agents:

```bash
seer init --client claude,cursor
```

See exactly what it would write without touching anything:

```bash
seer init --print
```

Full options live in [MCP Setup](mcp.md). If you would rather paste the snippet
yourself, that page has the exact JSON/TOML for every client.

---

## 3. First query

Restart (or reload the MCP servers in) your agent. Seer indexes the workspace
automatically the first time it is queried, so you do not have to run an index
step by hand. Ask your agent something like:

> Call seer_health, then give me the architecture overview.

If `seer_health` comes back with a schema version and some role counts, you are
connected.

---

## 4. Using the CLI directly (optional)

The same engine works from a plain shell, which is handy for scripting or just
poking around:

```bash
seer index .                 # build/refresh the index
seer architecture            # one-page overview of the repo
seer symbols --top 20        # top symbols by PageRank
seer preflight --symbol foo  # everything you need before editing `foo`
```

The full command list is in the [CLI Reference](cli.md).

---

## Where the index lives

Seer writes a single SQLite file to `<repo>/.seer/graph.db`. Add `.seer/` to
your `.gitignore` if you do not want to commit it. Delete the folder any time;
it rebuilds on the next query or `seer index`.

---

## Next steps

- [MCP Setup](mcp.md) for every client's config and troubleshooting.
- [Tool Guide](tools.md) for what each MCP tool returns.
- [Examples](examples.md) for real agent workflows.
- [Architecture](architecture.md) for how the index is built.
