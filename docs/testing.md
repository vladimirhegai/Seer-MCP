# Testing

## The short version

Seer ships with a large automated test suite: more than 900 individual checks
across 37 test files. Every check has to pass before anything is considered
done, and we keep a strict no-regression rule, so once a bug is fixed it gets a
test that fails if the bug ever comes back.

The tests fall into a few plain-English buckets:

| What it checks | In human terms |
|---|---|
| Reading code correctly | Does Seer pull the right functions, classes, and calls out of each language? |
| Not getting confused at scale | Does a huge repo index the same way every time, with no crashes? |
| Staying fresh | When a file changes, does the next answer reflect it, instantly? |
| The agent tools | Do the MCP tools return what they promise, including the token-saving ones? |
| Cross-service tracing | Do calls in one service correctly link to handlers in another? |
| Edit-impact features | Are risk, tests, history, and blast radius accurate? |
| Easy install | Does `seer init` write the right config for every agent? |
| Old bugs | Every bug we ever fixed has a test so it cannot return. |

If you just want to confirm everything works on your machine:

```bash
npm install
npm test
```

A green run means all of the above passed.

---

## The categories in a bit more detail

**Reading code (smoke tests).** Small hand-written fixtures in each supported
language. They confirm the parser finds the right symbols, builds the right
qualified names, and resolves basic calls. This is the foundation; if these
break, nothing else matters.

**Scale and determinism.** Seer indexes real, large open-source repos and checks
that a second run produces byte-identical counts, that the cache truly
rehydrates, and that nothing crashes or drifts. This is also where speed is
measured (see [Benchmarks](benchmarks.md)).

**Worker threads.** Parsing runs across multiple threads for speed. These tests
prove the parallel path produces the exact same result as the simple serial
path, and that a crashed worker is recovered without corrupting the index.

**Freshness and the watcher.** Simulates an agent editing files in bursts and
confirms the index updates instantly, without stalls, leaks, or duplicate rows,
and that deleted files are pruned.

**The MCP tools.** Drives the actual server the way an agent would, over its
real protocol, and checks each tool's output. A dedicated optimization spec
covers the token-budget trimming, the "did you mean" suggestions on typos, the
file-skeleton renderer, and the batch and trace helpers.

**Cross-service links.** Builds small multi-service repos and confirms that an
outbound call (HTTP, gRPC, tRPC, GraphQL, or a message queue) resolves to the
right route handler, including across separate repos via bundles.

**Edit-impact features.** The risk score, the ranked tests, the per-symbol
history, the monorepo boundaries, and the rename/move continuity all have their
own suites with concrete expected values.

**Install.** Confirms `seer init` writes valid, mergeable config for Claude
Code, Cursor, VS Code, Codex, Gemini, Antigravity, and Windsurf, writes the
right guidance files, that re-running is safe, and that it never clobbers your
existing settings.

**Regressions.** Every real bug found, including during the pre-release stress
pass, is pinned with a test in `tests/bug-regressions.ts`, so it cannot quietly
come back.

---

## Running your own

The whole suite:

```bash
npm test
```

Just one category (handy while working on a feature):

```bash
npm run test:smoke         # language extractors
npm run test:mcp           # the MCP server + optimization spec
npm run test:init          # the cross-agent installer
npm run test:tracke        # modules, behavior, risk, context
npm run test:trackg        # service links and protocols
npm run test:tracki        # external bundles, contract diff, preflight, boundaries, continuity
npm run test:regressions   # locked-in bug fixes
```

The large-codebase suite is separate because it needs real repos checked out
under `Large Codebases/` and takes a while:

```bash
npm run scale-test                       # all available codebases
npm run scale-test -- --only helix,react # a subset
npm run scale-test -- --skip unreal      # exclude the slow ones
```

It writes a human-readable summary to `tests/outputs/latest.md` and a full
machine-readable report alongside it.

There is also a parity gate that proves the parallel and serial indexers agree
row-for-row at scale:

```bash
npm run test:scale-parallel-parity
```

---

## What a passing run looks like

Each test file prints a line per check and a final tally. A clean run ends with
every file reporting `PASS` and a zero failure count. If anything fails, the
exit code is non-zero (so CI catches it) and the failing check prints what it
expected versus what it got.
