import fs from 'fs';
import { Store } from '../db/store.js';

/**
 * Track-F structural SimHash duplicate detection.
 *
 * For each function/method/constructor symbol we compute a 64-bit SimHash
 * over its STRUCTURAL token stream — identifier names are folded into their
 * "kind" (NAME / NUMBER / STRING / KEYWORD / OP) so two functions that do
 * the same shape with different variable names still match. This is the
 * classic Charikar SimHash construction, sized so two near-duplicates
 * differ in only a small Hamming distance.
 *
 * Why structural and not exact-tree? Exact-tree hashes (Merkle over the AST)
 * find verbatim copies; that's a small fraction of real-world duplication. A
 * SimHash over tokens with a sliding 3-gram window catches:
 *   - genuine copy-paste with renames
 *   - near-duplicate boilerplate (CRUD handlers, parser branches)
 *   - structural twins across files / languages with similar syntactic shape
 *
 * The trade-off is exact-equality false positives (two unrelated 3-line
 * helpers can hash close). We mitigate by:
 *   1. Requiring LOC >= MIN_LOC (default 4) to avoid trivial pairs.
 *   2. Computing the hash only over function/method/constructor symbols.
 *   3. Returning Hamming distance with every pair so the caller can filter.
 *
 * SCIP-merged symbols keep the tree-sitter hash; SCIP-only symbols never get
 * a hash because we don't see their bodies.
 */

const MIN_LOC_DEFAULT = 4;
const NGRAM_SIZE = 3;
const HASH_BITS = 64;

/** Tokens we recognize when computing the shape hash. */
type TokenKind = 'NAME' | 'NUMBER' | 'STRING' | 'KEYWORD' | 'OP';

interface ShapeToken {
  kind: TokenKind;
  /**
   * For keywords/operators we keep the lexeme so `if` ≠ `for` ≠ `while`.
   * For names/numbers/strings we drop the lexeme to fold them together —
   * structure first, content second.
   */
  text: string;
}

/**
 * A tiny language-agnostic tokenizer. We don't need to be a full lexer —
 * the goal is "structurally meaningful tokens that survive renames." A
 * char-class scan over the source body suffices:
 *   - identifier-start runs → NAME (folded)
 *   - digit runs → NUMBER (folded)
 *   - quoted strings → STRING (folded; we just skip until the closing quote)
 *   - operators / punctuation → OP (lexeme kept)
 *
 * Keywords aren't language-specific in this tokenizer — they appear as NAME
 * tokens. That's intentional: a Python `if` and a JS `if` have the same
 * structural role, and at the shape-hash level we want them to collide.
 * Real keywords still get distinguished from random identifiers because the
 * SURROUNDING operators differ ( `if (` vs `def foo(` ).
 */
export function tokenize(source: string): ShapeToken[] {
  const tokens: ShapeToken[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source.charCodeAt(i);
    // Whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
    // Line comment (// or #) — skip to EOL
    if ((c === 47 && source.charCodeAt(i + 1) === 47) || c === 35) {
      while (i < n && source.charCodeAt(i) !== 10) i++;
      continue;
    }
    // Block comment (/* … */)
    if (c === 47 && source.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i < n && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) i++;
      i += 2;
      continue;
    }
    // String — single, double, or backtick quoted; folded to a single STRING.
    if (c === 34 || c === 39 || c === 96) {
      const quote = c;
      i++;
      while (i < n) {
        const cc = source.charCodeAt(i);
        if (cc === 92) { i += 2; continue; } // escape: skip next char too
        if (cc === quote) { i++; break; }
        i++;
      }
      tokens.push({ kind: 'STRING', text: '' });
      continue;
    }
    // Identifier — letter / underscore / $ followed by alnum-underscore-$
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdContinue(source.charCodeAt(j))) j++;
      tokens.push({ kind: 'NAME', text: '' });
      i = j;
      continue;
    }
    // Number
    if (c >= 48 && c <= 57) {
      let j = i + 1;
      while (j < n) {
        const cc = source.charCodeAt(j);
        if ((cc >= 48 && cc <= 57) || cc === 46 || cc === 95 || cc === 120 || cc === 88) j++;
        else break;
      }
      tokens.push({ kind: 'NUMBER', text: '' });
      i = j;
      continue;
    }
    // Operator / punctuation — single char. We keep the lexeme so '{' ≠ '}'.
    tokens.push({ kind: 'OP', text: source[i] });
    i++;
  }
  return tokens;
}

function isIdStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}
function isIdContinue(c: number): boolean {
  return isIdStart(c) || (c >= 48 && c <= 57);
}

/**
 * Compute the 64-bit structural SimHash over a function body source string.
 * Returns NULL when the source is too small to be meaningfully compared.
 *
 * Algorithm (standard Charikar SimHash):
 *   1. Tokenize, fold names/numbers/strings, keep operator lexemes.
 *   2. Slide a 3-gram window over the tokens.
 *   3. For each n-gram compute a stable 64-bit hash (FNV-1a is plenty here).
 *   4. For each bit position, sum +1 if set in the gram-hash, -1 if unset.
 *   5. Output bit i is 1 iff sum_i > 0.
 */
export function computeShapeHash(body: string, minTokens = 8): bigint | null {
  const tokens = tokenize(body);
  if (tokens.length < minTokens) return null;
  const counters = new Int32Array(HASH_BITS);
  const ngram: string[] = [];
  for (const tok of tokens) {
    ngram.push(tok.kind === 'OP' ? `OP:${tok.text}` : tok.kind);
    if (ngram.length < NGRAM_SIZE) continue;
    if (ngram.length > NGRAM_SIZE) ngram.shift();
    const h = fnv64(ngram.join('|'));
    // Split the 64-bit hash into two 32-bit halves ONCE, then walk the bits
    // with plain 32-bit number ops. The previous version did 64 BigInt shifts
    // per n-gram; BigInt is an order of magnitude slower than number math and
    // this loop is the hot path. The produced bits are identical, so stored
    // hashes and duplicate clustering are unchanged.
    const lo = Number(h & 0xFFFFFFFFn);
    const hi = Number((h >> 32n) & 0xFFFFFFFFn);
    for (let b = 0; b < 32; b++) counters[b] += ((lo >>> b) & 1) ? 1 : -1;
    for (let b = 0; b < 32; b++) counters[b + 32] += ((hi >>> b) & 1) ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < HASH_BITS; b++) {
    if (counters[b] > 0) out |= (1n << BigInt(b));
  }
  return out;
}

/** FNV-1a 64-bit hash. Stable, deterministic, no dependencies. */
function fnv64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xFFFFFFFFFFFFFFFFn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * PRIME) & MASK;
  }
  return h;
}

/** Hamming distance between two 64-bit bigints. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= (x - 1n);
    count++;
  }
  return count;
}

export interface BuildShapeHashResult {
  symbolsHashed: number;
  symbolsSkipped: number;
  elapsedMs: number;
}

/**
 * Compute shape hashes for every function-like symbol in the DB by reading
 * its file and slicing out the body. We re-read each file once and slice all
 * its function bodies in one pass.
 *
 * Idempotent: skips symbols that already have a shape_hash and whose file
 * hash hasn't changed since the last pass (Store.upsertFileWithCache will
 * have NULLed the column for re-parsed files automatically because the row
 * gets deleted-and-reinserted).
 */
export function buildShapeHashes(
  store: Store,
  options: { minLoc?: number; force?: boolean; log?: (m: string) => void } = {},
): BuildShapeHashResult {
  const start = Date.now();
  const minLoc = options.minLoc ?? MIN_LOC_DEFAULT;
  const log = options.log ?? (() => { /* */ });
  if (!store.hasV7()) {
    log('shape hashes require schema v7; skipping');
    return { symbolsHashed: 0, symbolsSkipped: 0, elapsedMs: Date.now() - start };
  }

  // Pull every function/method/constructor symbol with loc >= minLoc that
  // doesn't already have a shape_hash.
  const where = options.force ? '' : 'AND s.shape_hash IS NULL';
  const rows = store.rawDb().prepare(`
    SELECT s.id, s.line_start AS lineStart, s.line_end AS lineEnd, s.loc, f.path AS filePath
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.kind IN ('function','method','constructor')
      AND s.symbol_role <> 'declaration'
      AND s.loc >= ?
      ${where}
    ORDER BY f.path
  `).all(minLoc) as Array<Record<string, unknown>>;

  let symbolsHashed = 0;
  let symbolsSkipped = 0;
  let lastFile = '';
  let lastLines: string[] | null = null;
  // node:sqlite — minor optimization: prepare the update once and reuse.
  const setHash = store.rawDb().prepare(
    'UPDATE symbols SET shape_hash = ? WHERE id = ?',
  );
  // Same signed-bigint conversion the Store uses for storage round-trip.
  const toSigned = (u: bigint): bigint => {
    const MAX = 0x7FFFFFFFFFFFFFFFn;
    return u > MAX ? u - 0x10000000000000000n : u;
  };

  // CRITICAL: wrap every UPDATE in a single transaction. Without this, each
  // `setHash.run()` auto-commits on its own, and with WAL + synchronous=FULL
  // that is one disk sync per symbol. On a large repo (or a slow/contended
  // disk) thousands of individual commits turn a sub-second pass into tens of
  // seconds — it was the single biggest cost in a fresh index. One BEGIN/COMMIT
  // collapses all of those syncs into one.
  const db = store.rawDb();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const filePath = String(r.filePath);
      if (filePath !== lastFile) {
        lastFile = filePath;
        // Split each file into lines ONCE, not once per symbol. The old code
        // re-split the whole source for every function in the file, which is
        // quadratic in file size for symbol-dense files.
        try { lastLines = (fs.readFileSync(filePath, 'utf-8') as string).split(/\r?\n/); }
        catch { lastLines = null; }
      }
      if (lastLines == null) { symbolsSkipped++; continue; }
      const lineStart = Number(r.lineStart);
      const lineEnd = Number(r.lineEnd);
      const body = lastLines.slice(lineStart, lineEnd + 1).join('\n');
      const hash = computeShapeHash(body);
      if (hash == null) { symbolsSkipped++; continue; }
      setHash.run(toSigned(hash), Number(r.id));
      symbolsHashed++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw err;
  }
  log(`Hashed ${symbolsHashed} symbols (${symbolsSkipped} skipped)`);
  return { symbolsHashed, symbolsSkipped, elapsedMs: Date.now() - start };
}

export interface DuplicateCluster {
  fingerprint: bigint;
  symbols: Array<{
    id: number; name: string; qualifiedName: string | null; kind: string;
    file: string; lineStart: number; lineEnd: number; loc: number | null;
    hammingFromAnchor: number;
  }>;
}

export interface FindDuplicatesOptions {
  /** Maximum Hamming distance two symbols may differ to count as duplicates. */
  maxDistance?: number;
  /** Minimum LOC for a symbol to be considered. */
  minLoc?: number;
  /** Include test files. */
  includeTests?: boolean;
  /** Hard cap on clusters returned. */
  maxClusters?: number;
}

/**
 * Find clusters of structurally near-duplicate symbols.
 *
 * Implementation: pairwise Hamming distance over the candidate set. For
 * codebases up to ~20k functions this stays well under a second; bigger
 * codebases can pre-bucket on the top 16 bits of the hash (we don't do that
 * here yet — the current scale works). The output is grouped into clusters
 * via simple transitive-closure union-find on the (distance ≤ N) graph.
 */
export function findDuplicates(
  store: Store, options: FindDuplicatesOptions = {},
): DuplicateCluster[] {
  const maxDistance = options.maxDistance ?? 6;
  const minLoc = options.minLoc ?? MIN_LOC_DEFAULT;
  const includeTests = options.includeTests ?? false;
  const maxClusters = options.maxClusters ?? 200;

  const candidates = store.listSymbolsWithShapeHash({
    minLoc, includeTests, limit: 50000,
  });
  if (candidates.length < 2) return [];

  // Union-find.
  const parent = new Int32Array(candidates.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Pairwise. N² for now — acceptable up to ~10k candidates (50M comparisons
  // each ~100ns = 5s worst case). Bigger codebases should bucket first.
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      // Skip pairs from the same symbol (same id). Two rows can share the
      // same id when one is a tree-sitter / scip-merge overlap.
      if (a.id === b.id) continue;
      const d = hammingDistance(a.shapeHash, b.shapeHash);
      if (d <= maxDistance) union(i, j);
    }
  }

  // Group by root.
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const r = find(i);
    let bucket = clusters.get(r);
    if (!bucket) { bucket = []; clusters.set(r, bucket); }
    bucket.push(i);
  }

  const out: DuplicateCluster[] = [];
  for (const indices of clusters.values()) {
    if (indices.length < 2) continue;
    const anchor = candidates[indices[0]];
    out.push({
      fingerprint: anchor.shapeHash,
      symbols: indices.map(i => {
        const s = candidates[i];
        return {
          id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind,
          file: s.filePath, lineStart: s.lineStart, lineEnd: s.lineEnd, loc: s.loc,
          hammingFromAnchor: hammingDistance(anchor.shapeHash, s.shapeHash),
        };
      }).sort((x, y) => x.hammingFromAnchor - y.hammingFromAnchor),
    });
    if (out.length >= maxClusters) break;
  }
  // Largest clusters first; ties broken by lowest fingerprint for stability.
  out.sort((a, b) => b.symbols.length - a.symbols.length
    || (a.fingerprint < b.fingerprint ? -1 : 1));
  return out;
}
