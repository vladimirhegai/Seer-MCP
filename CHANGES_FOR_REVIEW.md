# Seer — Change Report for Review (2026-06-04)

Audience: a reviewing agent. This documents every code change made in response to
(a) three review agents' feedback (Gemini / Codex / Claude) gathered in the Godot
codebase, and (b) the maintainer's wizard feedback. Each agent claim was
**re-verified against the real Godot index** before acting — several were
confirmed bugs, one was a misattribution, and a few are honestly scoped as
best-effort or deferred.

Repo: `c:\dev\Coding\Strata` (package `seer-mcp`). Build: `npm run build` (tsc,
clean). Node 26, `node:sqlite`. Test DB used for verification:
`C:\dev\Coding\Godot\.seer\graph.db` (353 MB, C/C++).

**Net:** 12 files, +703/−165. Full local test sweep green (counts at the bottom).

---

## 0. Ground-truth established before any change

Queried the live Godot DB to separate real bugs from hallucinations:

- `Node.add_child` **does** resolve via `getDefinition` (id 238660, `scene/main/node.cpp`). Resolved call sites = **6**; by-name (`add_child`) call sites = **4252** — exactly the "6 → 4252" the agents reported.
- C++ qualified names are stored in **dot form** (`Node.add_child`, `TreeItem.add_child`, `FabrikInverseKinematic.ChainItem.add_child`), not `::`.
- `symbol_history` rows = **0** (history never built there).
- `git log -p --follow` on `node.cpp` = **0.69 s** (not a timeout).

---

## 1. CONFIRMED BUG — scoped symbol-history build matched 0 files on Windows  ★ highest impact

**Claim (Gemini):** "failed to get the git history of a specific symbol … scoped
`seer_symbol_history_build { paths: ["scene/main/node.cpp"] }` … didn't return rows."

**Reproduced:** `seer symbol-history --paths scene/main/node.cpp` →
`0 rows across 0 files (205ms)`.

**Root cause (verified):**
- Stored `f.path` = `c:\dev\Coding\Godot\…` (lower-case `c:`).
- `path.resolve(repoRoot, rel)` = `C:\dev\Coding\Godot\…` (upper-case `C:`).
- `Store.listSymbolsForHistoryIndexForFiles` matched `f.path IN (?)` **exactly** →
  `c:\…` ≠ `C:\…` → 0 files → 0 rows.

This broke **every** scoped/on-demand history build on Windows — i.e. the
agent-facing "~1 s fast path" never worked there. The drive-letter case (and `/`
vs `\`) differs between the indexed value and `path.resolve`.

**Fix:**
- `src/db/store.ts` `listSymbolsForHistoryIndexForFiles`: normalize both sides
  (lower-case + forward slashes, strip `./` and trailing `/`) and match against
  **`f.path` OR `f.rel_path`**, so an absolute path, a relative path, or a
  differently-cased drive letter all resolve.
- `src/indexer/symbolhistory.ts`: pass BOTH the raw inputs and their absolute
  resolution as match hints (rel paths now match `rel_path` directly).

**Verified after fix:** same command → `562 rows across 1 file (790ms)`; `seer
history "Node.add_child"` returns 4 commits.

---

## 2. seer_history now auto-builds on a cold miss (Gemini #5 + Claude #3)

**Claim (Claude):** "requiring a build before returning anything creates a jarring
two-step flow. A lazy on-demand build … would be a better default." (Gemini hit
the same wall.) Confirmed: `symbol_history` was empty, so the first call returned
only a `buildHint`.

**Change (`src/mcp/server.ts`, `seer_history`):** on a cold miss (symbol resolves,
no rows, full index not yet built) it builds **just that symbol's file(s)** inline
— bounded (15 s deadline, 10 s git timeout), and `useResumeWatermarks: false` so a
stale watermark (rows cleared but watermark kept) can't suppress it.
`replaceSymbolHistoryForSymbols` is delete-then-insert, so the rebuild can't
duplicate rows. New `autoBuild` arg (default **true**); `autoBuild: false` keeps a
strictly read-only lookup. `seer_batch` forces `autoBuild: false` so a batch stays
read-only. An `autoBuild` summary block is returned for transparency.

**Why default-on:** the maintainer forwarded Claude's "better default" explicitly;
it's bounded and idempotent; it does not touch the symbol/edge tables. The
expensive **full-repo** history pass stays explicit.

**Verified (end-to-end MCP):** cold `seer_history { "Node.add_child" }` →
`autoBuild.ran=true, rowsInserted=562`, returns 4 commits in ~1 s.

---

## 3. seer_callers narrowing for the 6→4252 ambiguity (Gemini #1, Codex #4, Claude #1)

The top cross-agent request. Three additions to `seer_callers`
(`src/mcp/server.ts` + new `src/db/store.ts` methods):

- **`groupByFile: true`** — accurate per-file breakdown of the by-name call sites
  (`groupCallersByFile` + `countCallerFilesByName`, both `GROUP BY`/`COUNT DISTINCT`,
  exact over ALL sites). Verified: `add_child` → 266 files; top = `theme_editor_plugin.cpp` (155), `node_3d_editor_plugin.cpp` (122)…
- **`nameMatchOffset`** — paging for the by-name list (`offset`/`returned`/`nextOffset`),
  fixing the hard 50-row cap Claude flagged. Verified paging across 676 unique callers.
- **`filterReceiverType`** (a class name, or `true` to infer it from the target) —
  best-effort receiver attribution. Reads each candidate call line + a bounded
  same-file window and buckets each site as **confirmedTarget** / **confirmedSibling**
  (the "discard `TreeItem->add_child`" Gemini asked for) / **unresolved**, with a
  `plausibleUpperBound`.

**Honesty note (important for the reviewer):** I empirically measured this on
Godot. Local receiver typing is rarely resolvable in C++ without SCIP:
`add_child`/`Node` → confirmedTarget **44**, confirmedSibling **5**
(TreeItem 4, ChainItem 1), unresolved **4203**, `plausibleUpperBound` **4247**.
So the filter narrows `[6, 4252]` to `[44, 4247]` *with confidence* and excludes
confirmed siblings — but it is deliberately **not** a precise count, and every
response says so and points at SCIP for precision. I kept it because (a) all three
agents asked, (b) it's honest + bounded, (c) `groupByFile` + this together are
strictly more than agents had. I did **not** dress up low-recall heuristics as a
precise answer.

---

## 4. Declaration-vs-definition honesty hint (Codex #1)

**Claim (Codex):** "`seer_context` succeeded for the definition in node.cpp but not
the declaration in node.h … felt inconsistent." Confirmed: the default search
excludes declarations, so a header prototype yields "no symbol".

**Change:** new `declarationHint` helper, wired into `seer_context`,
`seer_definition`, `seer_callers`, `seer_behavior` miss paths. When a name resolves
**only** to a declaration, it returns a hint naming the declaration site and the
**matching** definition. Verified: `seer_context { add_child, file: node.h }` →
hint points at `Node.add_child` in `node.cpp:1710` (a first naive version pointed at
the higher-PageRank `ChainItem.add_child`; fixed to resolve the declaration's own
class).

---

## 5. seer_behavior — honest "test references" count (Claude #2)

**Claim (Claude):** heuristic-only coverage "felt like a dead end … I had to grep
tests/ to find the files." **Change:** when coverage is `heuristic-only` /
`tests-indexed-no-link`, `seer_behavior` now returns `testNameReferences`
(`countNameCallsInTests`: by-name call sites in test-role files + distinct file
count), labelled as **references, not verified coverage**. Verified on Godot:
`add_child` → 2 sites in 1 test file.

---

## 6. Qualified-name robustness (Codex #2)

**Claim (Codex):** "`Node.add_child` did not resolve in some tools." **Finding:**
on Godot it **does** resolve (storage is dot-form). The reported failure was most
likely the rows=0 history case (#2), not name resolution — i.e. a misattribution,
not a separate bug. Still, `symbolNameVariants` only converted `::`→`.`, never the
reverse. I made it **symmetric** (`.`↔`::`) so a `::`-form name (e.g. from a SCIP
import) also resolves. Low-risk, additive; covered by existing query-parity tests.

---

## 7. Maintainer wizard feedback (`seer init`)

- **Single-select primary agent (was multi-select).** A Seer index belongs to one
  repo, so "which agent?" is now one choice (`parseSingleSelection`). Power users
  wanting several still use `--client a,b`. Antigravity's extension follow-up stays
  multi-select (it genuinely hosts several).
- **Accurate detection.** New `detectActiveClient` (env-first: `CLAUDECODE`,
  VS Code-fork app paths for Antigravity/Cursor/Windsurf, `TERM_PROGRAM`, …) names
  **one** agent or `null`. The wizard pre-selects only that, instead of marking
  every client "(detected)" — the behaviour the maintainer saw inside Antigravity.
  Conservative: returns `null` when unsure and the user picks. `--auto`'s
  `detectAutoClients` is unchanged (documented power flag).
- **"Second question" check.** The extensions follow-up only applies to Antigravity
  (the one host that runs other agents' extensions). With single-select, picking
  Codex/Claude/etc. skips it entirely — exactly the maintainer's point.
- **Clean Ctrl-C (Gemini #3).** `readlineIO` attaches a SIGINT→`AbortController`;
  `runInitWizard` catches the abort and prints "Setup cancelled." instead of a raw
  `AbortError` stack trace.

`src/cli/prompt.ts` (rewritten), `src/cli/init.ts` (+`detectActiveClient`),
`src/cli/index.ts` (wizard uses `detectActiveClient`).

---

## 8. Guidance + docs

`AGENTS.md` block (`src/cli/init.ts`) and MCP `instructions` (`src/mcp/server.ts`)
updated for the new history flow (auto-build; `autoBuild:false`; full build stays
explicit) and caller narrowing (`groupByFile` / `filterReceiverType` /
`nameMatchOffset`; SCIP for exact). README Quick Start, `docs/quickstart.md`,
`docs/mcp.md`, `docs/tools.md` updated (single-select wizard; `seer_history`
auto-build; `seer_callers` options).

---

## Deferred (with rationale — NOT done)

- **Strict trace by type hierarchy** (Gemini #2): needs a real type graph; large,
  out of scope for a heuristic pass.
- **Test-framework annotation parsing** (Gemini #4): moderate effort, lower ROI than
  the items above; `testNameReferences` (#5) covers the immediate need.
- **Risk: ClassDB-bound / `scriptingAPIExposed`** (Claude #5): Godot-specific
  binding detection; not generalizable into the deterministic risk model now.
- **Tool-discovery fragmentation** (Codex #3): client-side surfacing; already
  mitigated by `CORE_ALWAYS_LOAD` + `anthropic/alwaysLoad` meta. No server fix.

---

## How to verify (for the reviewer)

1. `npm run build` (clean).
2. Windows path bug: `node dist/cli/index.js symbol-history --workspace <repo> --paths "<rel/path.ext>"` should process the file (was 0 files when the indexed drive-letter case differed).
3. End-to-end MCP: start `dist/cli/index.js mcp --workspace <repo> --db <copy> --no-watch --no-jit`; on a copy with `DELETE FROM symbol_history`, `seer_history { <Class.method> }` returns rows with `autoBuild.ran=true`; `seer_callers { <Class.method>, groupByFile:true, filterReceiverType:true }` returns `byFile` + `receiverTypeFilter`.
4. Read the `filterReceiverType` note: confirm it never claims a precise count.

## Test results (local, all green)

init 93 · uninstall 41 · smoke ✓ · discovery 7 · filters ✓ · query-parity ✓ ·
bug-regressions ✓ · mcp-smoke 33 · mcp-history **8** (rewritten for the new
contract) · mcp-tracke 45 · mcp-trackcd 30 · optspec 47 · tracke ✓ ·
tracke-collisions 31 · git-features ✓ · trackf 74 · trackf-bugs 32 · trackg 312 ·
stability 27 · symbol-history-perf 84 · godot-fixes 76 · mcp-jit 4 · mcp-watcher 3 ·
mcp-trackf 36 · mcp-trackg 30 · mcp-tracki 16.

## Files changed

`src/db/store.ts` · `src/indexer/symbolhistory.ts` · `src/mcp/server.ts` ·
`src/cli/prompt.ts` · `src/cli/init.ts` · `src/cli/index.ts` · `tests/init.ts` ·
`tests/mcp-history.ts` · `README.md` · `docs/quickstart.md` · `docs/mcp.md` ·
`docs/tools.md`.
