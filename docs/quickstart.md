# Quick Start

Seer is a local MCP server. You point it at a repo, it builds a small SQLite
index, and your AI agent can then ask it structural questions instead of
grepping around. This page gets you from zero to a connected agent.

There is no account, no API key, and nothing leaves your machine.

You need **Node.js 24 or newer** (the index uses the built-in `node:sqlite`,
which runs without any flags on Node 24+).

---

## The one-command setup

From inside the repo you want indexed:

```bash
npx seer-mcp init
```

That is the whole install. It writes the MCP config for whatever agents you use
(Claude Code, Cursor, VS Code, Codex, Gemini) and drops an `AGENTS.md` so the
agent knows Seer exists and when to call it. Because it ran via `npx`, the config
it writes uses a portable `npx -y seer-mcp mcp` launcher, so it works the same on
any machine and is safe to commit.

Then reload (or restart) your agent so it picks up the new server.

### Useful variations

```bash
npx seer-mcp init --client all     # also Antigravity and the user-level configs
npx seer-mcp init --print          # dry run: show the snippets, write nothing
npx seer-mcp init --client claude  # just one agent
```

`init` is idempotent and merges into existing config files without clobbering
your other servers. Run it again any time; it leaves existing entries alone
unless you pass `--force`. The exact per-client config (and how to paste it by
hand) is in [MCP Setup](mcp.md).

---

## First query

Seer indexes the workspace automatically the first time it is queried, so you do
not run an index step by hand. On a very large repo that first index can take a
couple of minutes; it is cached afterward, so you only ever pay it once.

You do not need any special command to "start" Seer. Just work as usual and the
agent will reach for it. If you want to confirm the connection, ask the agent to
call `seer_health`; a reply with a schema version and role counts means you are
good.

> [!TIP]
> **Optional Pre-indexing:** If you want to avoid any first-query latency from your agent, you can pre-index your workspace manually in your terminal before launching the agent:
> ```bash
> npx seer-mcp index .
> ```

---

## Using the CLI directly (optional)

The same engine works from a plain shell, which is handy for scripting or just
poking around. With a global install you get a `seer` command:

```bash
npm install -g seer-mcp

seer index .                 # build/refresh the index
seer architecture            # one-page overview of the repo
seer symbols --top 20        # top symbols by PageRank
seer preflight --symbol foo  # everything you need before editing `foo`
```

Or run any command ad-hoc with `npx seer-mcp <command>`. The full command list
is in the [CLI Reference](cli.md).

---

## From source (contributors)

If you are hacking on Seer itself rather than just using it:

```bash
git clone https://github.com/vladimirhegai/Seer-Core.git
cd Seer-Core
npm install
npm run build      # produces dist/cli/index.js
```

Run `seer init` from a source checkout and it writes a launcher that points at
your local `dist/` build instead of `npx`, so you can test changes immediately.

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
