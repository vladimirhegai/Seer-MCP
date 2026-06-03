import fs from 'fs';
import path from 'path';
import { Store } from '../db/store.js';
import type { SymbolRow } from '../types.js';

/**
 * Tests-as-behavioral-spec, ranked.
 *
 * The Track-D `seer_behavior` returned raw 'tests' edges with no ranking,
 * which made it hard for an agent to pick the test most worth reading.
 * Track-E presents a ranked behavioral contract:
 *
 *   - DIRECT coverage: synthesized 'tests' edges into the symbol
 *   - INDIRECT coverage: tests that call something the symbol transitively
 *     reaches (depth-limited)
 *   - NAMING-CONVENTION coverage: test symbols whose name contains the
 *     target's name (`testLogin`, `test_login`, `loginShouldSucceed`)
 *   - SAME-FILE coverage: tests in a file that maps by convention to the
 *     production file (`auth_service.test.ts` ↔ `auth_service.ts`,
 *     `Login.spec.tsx` ↔ `Login.tsx`)
 *
 * Each test gets:
 *   - relationship  — which of the four signals matched (best match wins)
 *   - assertionCount — count of likely-assertion lines in the test body
 *   - graphDistance — BFS distance from the test caller to the target (1
 *     for direct, 2+ for indirect, null when found via naming/path only)
 *   - specificity   — derived ranking score (higher = stronger contract)
 *   - recency       — most recent file_churn last_commit_at when available
 *
 * Output is sorted by (specificity DESC, graphDistance ASC, file ASC).
 */

export type BehaviorRelationship =
  | 'direct-call'
  | 'indirect-call'
  | 'naming-convention'
  | 'same-file'
  | 'heuristic-name-call';

/**
 * Distinguishes the "why are there (no) graph-linked tests?" cases so an agent
 * can tell a genuine coverage gap — or precise coverage — from a name-based
 * guess or an indexing limitation:
 *   - graph-linked              — at least one PRECISE test link (call graph,
 *                                 naming, or path convention) was found.
 *   - heuristic-only            — the ONLY evidence is name-based heuristic
 *                                 (type-unresolved C/C++ member calls). A hint,
 *                                 not proof — never report this as precise.
 *   - tests-indexed-no-link     — test files exist, but none link to THIS symbol.
 *   - no-indexed-tests          — the workspace has zero indexed test files.
 *   - test-indexing-unavailable — the DB lacks file-role classification, so
 *                                 "test" can't be determined at all.
 */
export type BehaviorTestState =
  | 'graph-linked'
  | 'heuristic-only'
  | 'tests-indexed-no-link'
  | 'no-indexed-tests'
  | 'test-indexing-unavailable';

export interface RankedBehaviorTest {
  testSymbol: {
    id: number;
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
    lineEnd: number;
  };
  relationship: BehaviorRelationship;
  graphDistance: number | null;
  assertionCount: number;
  specificity: number;
  recentCommitAt: number | null;
  /**
   * True for name-based, type-unresolved evidence (C/C++ member calls whose
   * receiver type tree-sitter can't infer). Lower confidence — the test calls
   * SOME method of this name, not provably THIS symbol. See namedCallTestSites.
   */
  heuristic?: boolean;
}

export interface BehaviorResult {
  symbol: {
    id: number;
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
  };
  total: number;
  direct: number;
  indirect: number;
  namingMatches: number;
  sameFileMatches: number;
  /** Count of name-based heuristic (type-unresolved) test sites. */
  heuristicMatches: number;
  /** Which of the test-coverage states applies — see BehaviorTestState. */
  testCoverageState: BehaviorTestState;
  /** Total indexed test files (−1 when role classification is unavailable). */
  testsIndexed: number;
  /** Human-readable explanation of testCoverageState. */
  testCoverageNote: string;
  tests: RankedBehaviorTest[];
  source: 'tree-sitter';
}

const ASSERTION_PATTERNS: RegExp[] = [
  /\bexpect\s*\(/,
  /\bassert(?:Equals?|True|False|Throws?|That)?\s*\(/i,
  /\bshould\.(?:eq|equal|exist|throw|be)\b/i,
  /\b(?:should|to)\.(?:be|equal|throw|deep|have)\b/i,
  /\bassert!\s*\(/, // Rust `assert!` macro
  /\bassert_eq!\s*\(/, // Rust `assert_eq!`
  /\bassert\s+/, // Python `assert x == y`
];

const TEST_FILENAME_SUFFIXES = ['.test.', '.spec.', '_test.', '.tests.'];

/**
 * Compute the ranked behavioral contract for a target symbol.
 *
 * `nameOrId` may be a string (looked up via `getDefinition`) or a numeric id.
 * When `nameOrId` matches multiple symbols, the highest-PageRank one is used.
 */
export function rankedBehavior(
  store: Store,
  nameOrId: string | number,
  options: {
    limit?: number;
    indirectDepth?: number;
    includeNamingConvention?: boolean;
    includeSameFile?: boolean;
    /**
     * Name-based heuristic coverage for type-unresolved member calls (C/C++).
     * On by default; only fires when the target lives in a C/C++ file so other
     * languages (with resolvable receivers) keep precise-only behavior.
     */
    includeHeuristicCalls?: boolean;
  } = {},
): BehaviorResult | null {
  const limit = options.limit ?? 30;
  const indirectDepth = options.indirectDepth ?? 2;
  const includeNaming = options.includeNamingConvention ?? true;
  const includeSameFile = options.includeSameFile ?? true;
  const includeHeuristicCalls = options.includeHeuristicCalls ?? true;

  let target: SymbolRow | null = null;
  if (typeof nameOrId === 'number') {
    target = store.getSymbolById(nameOrId);
  } else {
    const candidates = store.getDefinition(nameOrId);
    if (candidates.length === 0) {
      // Try with includeDeclarations so we don't miss method-prototype targets.
      const decl = store.getDefinition(nameOrId, { includeDeclarations: true });
      target = decl[0] ?? null;
    } else {
      target = candidates[0];
    }
  }
  if (!target) return null;

  // ID-based lookup: never collapses same-short-name siblings. The
  // synthesizeTestEdges pass preserves the original call edge's resolved
  // to_id, so e.to_id == target.id is the correct id-scoped predicate.
  const directRows = store.directTestEdgesForId(target.id, 500);
  // Annotate with assertion counts (cheap: cached reads per file).
  const fileCache = new Map<string, string[]>();
  const readFileLines = (fp: string): string[] => {
    const cached = fileCache.get(fp);
    if (cached) return cached;
    let lines: string[] = [];
    try {
      const text = fs.readFileSync(fp, 'utf8');
      lines = text.split(/\r?\n/);
    } catch { /* */ }
    fileCache.set(fp, lines);
    return lines;
  };
  const assertionsForRange = (filePath: string, start: number, end: number): number => {
    const lines = readFileLines(filePath);
    if (lines.length === 0) return 0;
    let n = 0;
    const lo = Math.max(0, start);
    const hi = Math.min(lines.length - 1, end);
    for (let i = lo; i <= hi; i++) {
      const ln = lines[i];
      for (const re of ASSERTION_PATTERNS) {
        if (re.test(ln)) { n++; break; }
      }
    }
    return n;
  };

  const seenCallerIds = new Set<number>();
  const out: RankedBehaviorTest[] = [];

  for (const r of directRows) {
    if (seenCallerIds.has(r.callerId)) continue;
    seenCallerIds.add(r.callerId);
    const assertionCount = assertionsForRange(r.callerFile, r.callerLineStart, r.callerLineEnd);
    const recent = recentCommitForFile(store, r.callerFile);
    out.push({
      testSymbol: {
        id: r.callerId,
        name: r.callerName,
        qualifiedName: r.callerQualifiedName,
        kind: r.callerKind,
        file: r.callerFile,
        lineStart: r.callerLineStart,
        lineEnd: r.callerLineEnd,
      },
      relationship: 'direct-call',
      graphDistance: 1,
      assertionCount,
      specificity: scoreSpecificity('direct-call', 1, assertionCount),
      recentCommitAt: recent,
    });
  }

  // ── INDIRECT coverage ────────────────────────────────────────────────────
  // For each test symbol whose call graph reaches target within
  // `indirectDepth`, record it once. We deliberately use the reverse-reachable
  // walk from the target so we don't fan out from every test file.
  if (indirectDepth > 0) {
    const reverseHits = store.reverseReachableWithDepth(target.id, indirectDepth + 1);
    // Filter to symbols that live in test files (role='test') AND haven't
    // already been picked up as direct.
    const candidateIds = reverseHits.map(h => h.id);
    if (candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => '?').join(',');
      const rows = store.rawDb().prepare(`
        SELECT s.id, s.name, s.qualified_name AS qualifiedName, s.kind,
               f.path AS file, s.line_start AS lineStart, s.line_end AS lineEnd,
               f.role AS fileRole
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.id IN (${placeholders}) AND f.role = 'test'
      `).all(...candidateIds) as Array<{
        id: unknown; name: unknown; qualifiedName: unknown; kind: unknown;
        file: unknown; lineStart: unknown; lineEnd: unknown; fileRole: unknown;
      }>;
      const depthById = new Map(reverseHits.map(h => [h.id, h.depth]));
      for (const r of rows) {
        const id = Number(r.id);
        if (seenCallerIds.has(id)) continue;
        seenCallerIds.add(id);
        const fp = String(r.file);
        const start = Number(r.lineStart);
        const end = Number(r.lineEnd);
        const distance = depthById.get(id) ?? 2;
        const assertionCount = assertionsForRange(fp, start, end);
        out.push({
          testSymbol: {
            id,
            name: String(r.name),
            qualifiedName: r.qualifiedName == null ? null : String(r.qualifiedName),
            kind: String(r.kind),
            file: fp,
            lineStart: start,
            lineEnd: end,
          },
          relationship: 'indirect-call',
          graphDistance: distance,
          assertionCount,
          specificity: scoreSpecificity('indirect-call', distance, assertionCount),
          recentCommitAt: recentCommitForFile(store, fp),
        });
      }
    }
  }

  // ── NAMING-CONVENTION coverage ──────────────────────────────────────────
  // Test-file symbols whose name contains the target name (case-insensitive,
  // word-boundary). Skips anything already seen via direct/indirect.
  if (includeNaming) {
    const needle = target.name;
    if (needle && needle.length >= 3) {
      const likes = [`%${needle}%`];
      const rows = store.rawDb().prepare(`
        SELECT s.id, s.name, s.qualified_name AS qualifiedName, s.kind,
               f.path AS file, s.line_start AS lineStart, s.line_end AS lineEnd
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.role = 'test'
          AND s.kind IN ('function','method')
          AND (s.name LIKE ? COLLATE NOCASE)
      `).all(...likes) as Array<{
        id: unknown; name: unknown; qualifiedName: unknown; kind: unknown;
        file: unknown; lineStart: unknown; lineEnd: unknown;
      }>;
      for (const r of rows) {
        const id = Number(r.id);
        if (seenCallerIds.has(id)) continue;
        const tname = String(r.name);
        if (!nameMatches(tname, needle)) continue;
        seenCallerIds.add(id);
        const fp = String(r.file);
        const start = Number(r.lineStart);
        const end = Number(r.lineEnd);
        const assertionCount = assertionsForRange(fp, start, end);
        out.push({
          testSymbol: {
            id,
            name: tname,
            qualifiedName: r.qualifiedName == null ? null : String(r.qualifiedName),
            kind: String(r.kind),
            file: fp,
            lineStart: start,
            lineEnd: end,
          },
          relationship: 'naming-convention',
          graphDistance: null,
          assertionCount,
          specificity: scoreSpecificity('naming-convention', null, assertionCount),
          recentCommitAt: recentCommitForFile(store, fp),
        });
      }
    }
  }

  // ── SAME-FILE coverage (path convention) ────────────────────────────────
  if (includeSameFile) {
    const targetFile = target.filePath;
    const candidateTestFiles = candidateTestFilesForProduction(targetFile);
    if (candidateTestFiles.length > 0) {
      const placeholders = candidateTestFiles.map(() => '?').join(',');
      const rows = store.rawDb().prepare(`
        SELECT s.id, s.name, s.qualified_name AS qualifiedName, s.kind,
               f.path AS file, s.line_start AS lineStart, s.line_end AS lineEnd
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.role = 'test'
          AND s.kind IN ('function','method')
          AND (f.path IN (${placeholders}) OR f.rel_path IN (${placeholders}))
      `).all(...candidateTestFiles, ...candidateTestFiles) as Array<{
        id: unknown; name: unknown; qualifiedName: unknown; kind: unknown;
        file: unknown; lineStart: unknown; lineEnd: unknown;
      }>;
      for (const r of rows) {
        const id = Number(r.id);
        if (seenCallerIds.has(id)) continue;
        seenCallerIds.add(id);
        const fp = String(r.file);
        const start = Number(r.lineStart);
        const end = Number(r.lineEnd);
        const assertionCount = assertionsForRange(fp, start, end);
        out.push({
          testSymbol: {
            id,
            name: String(r.name),
            qualifiedName: r.qualifiedName == null ? null : String(r.qualifiedName),
            kind: String(r.kind),
            file: fp,
            lineStart: start,
            lineEnd: end,
          },
          relationship: 'same-file',
          graphDistance: null,
          assertionCount,
          specificity: scoreSpecificity('same-file', null, assertionCount),
          recentCommitAt: recentCommitForFile(store, fp),
        });
      }
    }
  }

  // ── HEURISTIC name-call coverage (type-unresolved C/C++ member calls) ────
  // C/C++ member calls (`node->add_child(child)`) carry only the method's short
  // name in the call edge — tree-sitter can't infer the receiver's static type,
  // so the edge never resolves to THIS specific `Node.add_child` id and every
  // precise pass above misses it. When the target lives in a C/C++ file we
  // surface a clearly-labeled, lower-confidence signal: test functions that
  // call SOME method of the same name. It's name-based, not type-resolved
  // (`Tree::add_child` would match too), so it ranks below resolved signals and
  // every row is flagged `heuristic: true`. The precision path is a SCIP
  // overlay that resolves the receiver and promotes these to real DIRECT edges.
  if (
    includeHeuristicCalls &&
    isUnresolvedReceiverLang(target.filePath) &&
    isMemberLikeTarget(target.qualifiedName) &&
    target.name
  ) {
    const heuristicRows = store.namedCallTestSites(target.name, target.id, 200);
    for (const r of heuristicRows) {
      if (seenCallerIds.has(r.callerId)) continue;
      seenCallerIds.add(r.callerId);
      const assertionCount = assertionsForRange(r.callerFile, r.callerLineStart, r.callerLineEnd);
      out.push({
        testSymbol: {
          id: r.callerId,
          name: r.callerName,
          qualifiedName: r.callerQualifiedName,
          kind: r.callerKind,
          file: r.callerFile,
          lineStart: r.callerLineStart,
          lineEnd: r.callerLineEnd,
        },
        relationship: 'heuristic-name-call',
        graphDistance: null,
        assertionCount,
        specificity: scoreSpecificity('heuristic-name-call', null, assertionCount),
        recentCommitAt: recentCommitForFile(store, r.callerFile),
        heuristic: true,
      });
    }
  }

  // Sort and slice.
  out.sort((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    const ad = a.graphDistance ?? 99;
    const bd = b.graphDistance ?? 99;
    if (ad !== bd) return ad - bd;
    if (a.testSymbol.file !== b.testSymbol.file) {
      return a.testSymbol.file < b.testSymbol.file ? -1 : 1;
    }
    return a.testSymbol.lineStart - b.testSymbol.lineStart;
  });

  const direct = out.filter(t => t.relationship === 'direct-call').length;
  const indirect = out.filter(t => t.relationship === 'indirect-call').length;
  const namingMatches = out.filter(t => t.relationship === 'naming-convention').length;
  const sameFileMatches = out.filter(t => t.relationship === 'same-file').length;
  const heuristicMatches = out.filter(t => t.relationship === 'heuristic-name-call').length;

  // Distinguish a real coverage gap from an indexing limitation so the agent
  // doesn't read "0 tests" as "this code is untested" when tests simply can't
  // be classified (or none were indexed). Heuristic (name-based) matches are
  // passed separately so a symbol whose ONLY evidence is heuristic reads as
  // `heuristic-only`, never the precise-sounding `graph-linked`.
  const preciseLinked = out.length - heuristicMatches;
  const { testCoverageState, testsIndexed, testCoverageNote } =
    classifyTestCoverage(store, preciseLinked, heuristicMatches);

  return {
    symbol: {
      id: target.id,
      name: target.name,
      qualifiedName: target.qualifiedName,
      kind: target.kind,
      file: target.filePath,
    },
    total: out.length,
    direct,
    indirect,
    namingMatches,
    sameFileMatches,
    heuristicMatches,
    testCoverageState,
    testsIndexed,
    testCoverageNote,
    tests: out.slice(0, limit),
    source: 'tree-sitter',
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function scoreSpecificity(
  relationship: BehaviorRelationship,
  distance: number | null,
  assertionCount: number,
): number {
  // Base weights — direct > naming > same-file > indirect (distance > 1).
  // Direct calls are the strongest behavioral contract because the test
  // literally exercises the symbol; naming/same-file are good fallbacks;
  // indirect calls fade quickly with distance.
  let base: number;
  switch (relationship) {
    case 'direct-call':       base = 100; break;
    case 'naming-convention': base = 60; break;
    case 'same-file':         base = 40; break;
    case 'indirect-call':     base = Math.max(0, 50 - 10 * ((distance ?? 2) - 1)); break;
    // Name-based, type-unresolved: ranks below every resolved signal so it only
    // surfaces when nothing better exists, and never outranks a real test.
    case 'heuristic-name-call': base = 20; break;
  }
  // Each assertion line adds a small boost (capped at 20). A test that
  // exercises the symbol AND has assertions is a stronger contract than one
  // that calls but doesn't assert.
  const assertionBoost = Math.min(20, assertionCount * 4);
  return base + assertionBoost;
}

function nameMatches(testName: string, target: string): boolean {
  // Word-boundary-ish match: testName must contain the target as a contiguous
  // case-insensitive substring AND have a non-alphanumeric (or end) on at
  // least one side. Avoids `validate` matching `revalidateBackoff` etc.
  if (testName.length < target.length) return false;
  const lcT = testName.toLowerCase();
  const lcN = target.toLowerCase();
  let idx = lcT.indexOf(lcN);
  while (idx !== -1) {
    const before = idx === 0 ? '_' : lcT[idx - 1];
    const after = idx + lcN.length >= lcT.length ? '_' : lcT[idx + lcN.length];
    if (!/[a-z0-9]/.test(before) || !/[a-z0-9]/.test(after)) return true;
    // PascalCase: prev char uppercase, this char uppercase boundary
    idx = lcT.indexOf(lcN, idx + 1);
  }
  return false;
}

/**
 * For a production file path, produce candidate paths where its tests might
 * live. Covers the common conventions for the languages Seer indexes:
 *   - `src/auth_service.ts`         → `src/auth_service.test.ts`, `tests/auth_service.test.ts`
 *   - `src/components/Login.tsx`    → `src/components/Login.spec.tsx`, …
 *   - `pkg/auth/auth.go`            → `pkg/auth/auth_test.go`
 *   - `lib/auth.py`                 → `tests/test_auth.py`, `tests/auth_test.py`
 *   - `src/Auth.java`               → `src/test/java/AuthTest.java` (rough)
 */
function candidateTestFilesForProduction(prodPath: string): string[] {
  const out: string[] = [];
  const norm = prodPath.replace(/\\/g, '/');
  const dir = path.posix.dirname(norm);
  const ext = path.posix.extname(norm);
  const base = path.posix.basename(norm, ext);

  // JS/TS family: foo.ts → foo.test.ts, foo.spec.ts, foo.tests.ts
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    for (const tag of ['.test', '.spec', '.tests']) {
      out.push(`${dir}/${base}${tag}${ext}`);
      out.push(`${dir}/__tests__/${base}${tag}${ext}`);
      out.push(`tests/${base}${tag}${ext}`);
    }
  }
  // Go: foo.go → foo_test.go
  if (ext === '.go') {
    out.push(`${dir}/${base}_test.go`);
  }
  // Python: foo.py → test_foo.py, foo_test.py
  if (ext === '.py') {
    out.push(`${dir}/test_${base}.py`);
    out.push(`${dir}/${base}_test.py`);
    out.push(`tests/test_${base}.py`);
  }
  // Java/C# — Test suffix
  if (['.java', '.cs'].includes(ext)) {
    out.push(`${dir}/${base}Test${ext}`);
    out.push(`${dir}/${base}Tests${ext}`);
  }
  // C/C++ — test_foo.c etc.
  if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'].includes(ext)) {
    out.push(`${dir}/test_${base}${ext}`);
    out.push(`${dir}/${base}_test${ext}`);
  }
  // Rust — same file with #[cfg(test)] handled by direct; sibling tests dir
  if (ext === '.rs') {
    out.push(`${dir}/${base}_test.rs`);
    out.push(`tests/${base}.rs`);
  }
  return Array.from(new Set(out));
}

/**
 * C/C++ files are the ones where tree-sitter can't resolve a member call's
 * receiver type (`obj->method()` yields just `method`), so the name-based
 * heuristic earns its keep. Other indexed languages resolve receivers well
 * enough that adding name-only matches would only add noise.
 */
const UNRESOLVED_RECEIVER_EXTS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.c++', '.h', '.hh', '.hpp', '.hxx', '.h++', '.inl', '.ino',
]);
function isUnresolvedReceiverLang(filePath: string): boolean {
  const lc = filePath.toLowerCase();
  const dot = lc.lastIndexOf('.');
  if (dot === -1) return false;
  return UNRESOLVED_RECEIVER_EXTS.has(lc.slice(dot));
}

/**
 * The receiver-type-loss problem is specific to MEMBER calls (`obj->method()`):
 * a free-function call (`foo()` / `ns::foo()`) carries its own name and resolves
 * fine, so the name heuristic would only add noise for it. We approximate
 * "member" as "the symbol carries an owner scope" — a qualified name with a
 * non-empty dotted owner segment AND a leaf (`Node.add_child`, `A.B.compute`).
 * A bare, scope-less name (`compute`) is treated as a free function and skipped,
 * so the heuristic no longer fires on every function defined in a C/C++ file.
 *
 * A namespaced free function (`ns::foo` → `ns.foo`) also looks "owned" here; we
 * accept that imprecision because (a) tree-sitter gives us no scope KIND to tell
 * a namespace from a class, and (b) `namedCallTestSites` already excludes edges
 * that resolved to the target, so a uniquely-named free function surfaces
 * nothing to gate anyway.
 */
function isMemberLikeTarget(qualifiedName: string | null): boolean {
  if (!qualifiedName) return false;
  const dot = qualifiedName.lastIndexOf('.');
  // Need a non-empty owner segment before the dot and a non-empty leaf after it.
  return dot > 0 && dot < qualifiedName.length - 1;
}

/**
 * Decide which test-coverage state applies.
 *   - `preciseLinkedCount` — tests linked via a RESOLVED signal (call graph,
 *     naming, or path convention). These justify the precise `graph-linked`.
 *   - `heuristicCount` — name-based, type-unresolved matches only. On their own
 *     they earn the weaker `heuristic-only`, never `graph-linked`, so the agent
 *     doesn't mistake a name guess for proven coverage.
 */
function classifyTestCoverage(
  store: Store, preciseLinkedCount: number, heuristicCount: number,
): { testCoverageState: BehaviorTestState; testsIndexed: number; testCoverageNote: string } {
  if (!store.hasTestRoleClassification()) {
    return {
      testCoverageState: 'test-indexing-unavailable',
      testsIndexed: -1,
      testCoverageNote: 'This index lacks file-role classification, so test files can\'t be identified. Re-index with a current Seer build to enable test evidence.',
    };
  }
  const testsIndexed = store.countTestFiles();
  if (testsIndexed === 0) {
    return {
      testCoverageState: 'no-indexed-tests',
      testsIndexed,
      testCoverageNote: 'No test files are indexed in this workspace, so no behavioral coverage can be linked.',
    };
  }
  if (preciseLinkedCount > 0) {
    return {
      testCoverageState: 'graph-linked',
      testsIndexed,
      testCoverageNote: `${preciseLinkedCount} test(s) linked to this symbol via call graph, naming, or path convention.`
        + (heuristicCount > 0 ? ` (+${heuristicCount} lower-confidence heuristic match(es).)` : ''),
    };
  }
  if (heuristicCount > 0) {
    return {
      testCoverageState: 'heuristic-only',
      testsIndexed,
      testCoverageNote: `${heuristicCount} name-based heuristic match(es) only — a test calls a method of this name, but the receiver type is unresolved (typical for C/C++ member calls). Treat as a hint, not proof of coverage; confirm the receiver before relying on it.`,
    };
  }
  return {
    testCoverageState: 'tests-indexed-no-link',
    testsIndexed,
    testCoverageNote: `${testsIndexed} test file(s) are indexed, but none link to this symbol via call graph, naming, or path convention. Absence of a link is not proof the symbol is untested (e.g. unresolved cross-language or dynamic calls).`,
  };
}

function recentCommitForFile(store: Store, filePath: string): number | null {
  try {
    const churn = store.getFileChurn(filePath);
    return churn?.lastCommitAt ?? null;
  } catch { return null; }
}

/** Lightweight predicate used by other Track-E features. */
export function isTestFilePath(p: string): boolean {
  const lc = p.toLowerCase().replace(/\\/g, '/');
  if (lc.includes('/tests/') || lc.startsWith('tests/') || lc.includes('/__tests__/')) return true;
  for (const suf of TEST_FILENAME_SUFFIXES) if (lc.includes(suf)) return true;
  return false;
}
