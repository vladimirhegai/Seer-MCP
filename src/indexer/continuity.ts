/**
 * v10 — Symbol Rename/Move Continuity heuristics.
 *
 * Goal: when exact `symbol_key` history walking terminates (because the
 * function was renamed or moved), surface honest, confidence-labelled
 * continuity evidence so the agent can decide whether to trust the link.
 *
 * Heuristics (current pass — opt-in, low-confidence by default):
 *   - shape_hash exact match: previous-symbol candidate has the same
 *     structural SimHash → strong (confidence 0.85+)
 *   - shape_hash close match: small Hamming distance (≤ 4) + similar name
 *     → medium (confidence 0.65)
 *   - signature similarity: same arity + same containing class/module
 *     → weak (confidence 0.5)
 *   - same file rename history: file was renamed in git history, the
 *     historical file had a same-shape function with a different name → boost
 *     (confidence 0.75)
 *
 * Stored on `symbol_history_continuity`. Never pretends rename continuity
 * is certain.
 *
 * This module does NOT replace existing exact-key history. It only proposes
 * additional links when buildSymbolHistory's exact-key walk ran out of
 * commits. The Preflight / seer_history layers can read continuity rows
 * alongside symbol_history.
 */

import { Store } from '../db/store.js';

export interface ContinuityCandidate {
  symbolId: number;
  symbolKey: string;
  previousSymbolKey: string;
  previousName: string;
  previousFile: string;
  confidence: number;
  matchReasons: string[];
}

export interface ContinuityResult {
  candidatesConsidered: number;
  inserted: number;
  skipped: number;
  elapsedMs: number;
}

/**
 * Run the continuity pass over every symbol whose recorded history has
 * fewer than `historyThreshold` commits AND that has a shape_hash. For each
 * such symbol we scan other symbols sharing a close shape_hash and propose
 * the highest-confidence candidate (deduped per symbol_id).
 */
export function buildContinuity(
  store: Store,
  options: {
    historyThreshold?: number;
    maxHammingDistance?: number;
    log?: (msg: string) => void;
    /** When true, also create candidate links for symbols that have full history
     *  (useful for fixture tests and debugging). Default false. */
    includeAllSymbols?: boolean;
  } = {},
): ContinuityResult {
  const start = Date.now();
  const log = options.log ?? (() => { /* */ });
  const historyThreshold = options.historyThreshold ?? 1;
  const maxHamming = options.maxHammingDistance ?? 4;

  // Pool of candidates: every symbol with a shape_hash.
  const pool = store.listSymbolsWithShapeHash({ minLoc: 1, limit: 100000 });
  if (pool.length === 0) {
    log('no shape-hashed symbols; nothing to do');
    return { candidatesConsidered: 0, inserted: 0, skipped: 0, elapsedMs: Date.now() - start };
  }

  // Bucket by qualifiedName/name → list of candidates (so we can detect
  // rename: same shape, different name).
  const byHash = new Map<string, typeof pool>();
  for (const s of pool) {
    const k = s.shapeHash.toString();
    const list = byHash.get(k) ?? [];
    list.push(s);
    byHash.set(k, list);
  }

  let considered = 0;
  let inserted = 0;
  let skipped = 0;

  const raw = store.rawDb();
  // Prepare the history-count probe ONCE and reuse it. Re-preparing this inside
  // the loop (once per symbol) was needless overhead.
  const historyCount = raw.prepare(
    'SELECT COUNT(*) AS c FROM symbol_history WHERE symbol_id = ?',
  );

  // The close-hash match below is an all-pairs O(n^2) Hamming scan. It is the
  // speculative, low-confidence half of continuity (the high-value exact-shape
  // renames go through the O(1) `byHash` map). On a big repo n^2 is ruinous, so
  // we only run it when the pool is small enough to stay cheap. The exact-shape
  // path always runs regardless of pool size.
  const CLOSE_MATCH_POOL_CAP = 4000;
  const closeMatchEnabled = pool.length <= CLOSE_MATCH_POOL_CAP;

  for (const s of pool) {
    // Find the symbol's stored history count. If it's >= historyThreshold
    // AND we're not in includeAllSymbols mode, skip — exact history is fine.
    if (!options.includeAllSymbols) {
      const cnt = historyCount.get(s.id) as { c: number } | undefined;
      if (cnt && cnt.c >= historyThreshold) continue;
    }

    // Exact shape match candidates with a DIFFERENT (qualifiedName ?? name).
    const exactMatches = (byHash.get(s.shapeHash.toString()) ?? [])
      .filter(c => c.id !== s.id);
    if (exactMatches.length > 0) {
      const cand = pickBestCandidate(s, exactMatches);
      if (cand) {
        const sameClass = sharesContainingScope(s, cand);
        const nameRelated = similarName(s.name, cand.name);
        // How many OTHER symbols share this exact shape? A shape shared by many
        // symbols (trivial getters, `return null;`, boilerplate) is NOT a
        // reliable rename signal on its own. Only assert a high-confidence link
        // when the shape is (near-)unique to this pair; otherwise require
        // corroboration (same scope or a related name) and label the ambiguity
        // honestly with a lower, capped confidence. Never pretend certainty.
        const ambiguous = exactMatches.length >= 2;
        if (ambiguous && !sameClass && !nameRelated) {
          // Common shape, no corroborating evidence — do not invent a rename.
          skipped++;
          continue;
        }
        considered++;
        const reasons = ['shape_hash_exact'];
        if (sameClass) reasons.push('same_containing_scope');
        if (nameRelated) reasons.push('similar_name');
        let confidence: number;
        if (ambiguous) {
          reasons.push(`ambiguous_shape_bucket:n=${exactMatches.length + 1}`);
          confidence = 0.6;
          if (sameClass) confidence = Math.min(0.7, confidence + 0.05);
          if (nameRelated) confidence = Math.min(0.7, confidence + 0.05);
        } else {
          confidence = 0.85;
          if (sameClass) confidence = Math.min(0.95, confidence + 0.05);
          if (nameRelated) confidence = Math.min(0.95, confidence + 0.05);
        }
        upsertContinuity(store, {
          symbolId: s.id,
          symbolKey: keyFor(s),
          previousSymbolKey: keyFor(cand),
          previousName: cand.name,
          previousFile: cand.filePath,
          confidence,
          matchReasons: reasons,
        });
        inserted++;
        continue;
      }
    }

    // Close hash match (speculative; skipped on large repos — see cap above).
    if (!closeMatchEnabled) { skipped++; continue; }
    let best: { peer: typeof pool[number]; distance: number } | null = null;
    for (const peer of pool) {
      if (peer.id === s.id) continue;
      if ((peer.name === s.name) && (peer.qualifiedName === s.qualifiedName)) continue;
      const d = hammingDistance(s.shapeHash, peer.shapeHash);
      if (d > maxHamming) continue;
      if (!best || d < best.distance) best = { peer, distance: d };
    }
    if (best && best.distance <= maxHamming) {
      const cand = best.peer;
      // Only act when names are at least loosely related (share a prefix or
      // a suffix), to avoid pairing every short function in the codebase.
      if (similarName(s.name, cand.name) || sharesContainingScope(s, cand)) {
        considered++;
        const reasons = [`shape_hash_close:d=${best.distance}`];
        if (similarName(s.name, cand.name)) reasons.push('similar_name');
        if (sharesContainingScope(s, cand)) reasons.push('same_containing_scope');
        const confidence = best.distance === 0 ? 0.8
          : best.distance <= 2 ? 0.6
          : 0.4;
        upsertContinuity(store, {
          symbolId: s.id,
          symbolKey: keyFor(s),
          previousSymbolKey: keyFor(cand),
          previousName: cand.name,
          previousFile: cand.filePath,
          confidence,
          matchReasons: reasons,
        });
        inserted++;
        continue;
      }
    }

    skipped++;
  }

  return {
    candidatesConsidered: considered,
    inserted, skipped,
    elapsedMs: Date.now() - start,
  };
}

function upsertContinuity(
  store: Store, c: ContinuityCandidate,
): void {
  const raw = store.rawDb();
  raw.prepare(`
    INSERT INTO symbol_history_continuity
      (symbol_id, symbol_key, previous_symbol_key, previous_name, previous_file,
       bridging_sha, confidence, match_reasons, recorded_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(symbol_id, previous_symbol_key) DO UPDATE SET
      confidence = excluded.confidence,
      match_reasons = excluded.match_reasons,
      previous_name = excluded.previous_name,
      previous_file = excluded.previous_file,
      recorded_at = excluded.recorded_at
  `).run(
    c.symbolId, c.symbolKey, c.previousSymbolKey,
    c.previousName, c.previousFile,
    c.confidence, JSON.stringify(c.matchReasons),
    Date.now(),
  );
}

function keyFor(s: { kind: string; qualifiedName: string | null; name: string }): string {
  return `${s.kind}:${s.qualifiedName ?? s.name}`;
}

function sharesContainingScope(
  a: { qualifiedName: string | null; name: string; filePath: string },
  b: { qualifiedName: string | null; name: string; filePath: string },
): boolean {
  if (a.filePath === b.filePath) return true;
  // Compare class/module prefix in the qualified name (e.g. `AuthService.foo`
  // and `AuthService.bar` share `AuthService`).
  const aQual = a.qualifiedName ?? '';
  const bQual = b.qualifiedName ?? '';
  if (!aQual.includes('.') || !bQual.includes('.')) return false;
  const aPrefix = aQual.split('.').slice(0, -1).join('.');
  const bPrefix = bQual.split('.').slice(0, -1).join('.');
  return aPrefix.length > 0 && aPrefix === bPrefix;
}

function similarName(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return false; // we only flag potential RENAMES
  const aL = a.toLowerCase();
  const bL = b.toLowerCase();
  // Same prefix of length >= 4 or same suffix of length >= 4.
  const minLen = Math.min(aL.length, bL.length);
  if (minLen < 4) return false;
  let prefix = 0;
  while (prefix < minLen && aL[prefix] === bL[prefix]) prefix++;
  if (prefix >= 4) return true;
  let suffix = 0;
  while (suffix < minLen && aL[aL.length - 1 - suffix] === bL[bL.length - 1 - suffix]) suffix++;
  if (suffix >= 4) return true;
  // Names that differ by a verb prefix swap (validate → verify) — drop the
  // first 4 characters and compare the rest.
  if (aL.length >= 4 && bL.length >= 4 && aL.slice(4) === bL.slice(4)) return true;
  return false;
}

function pickBestCandidate<T extends { id: number; name: string; qualifiedName: string | null; filePath: string; kind: string }>(
  target: T,
  candidates: T[],
): T | null {
  // Prefer same-file rename. Then same-class rename. Then any candidate.
  const sameFile = candidates.filter(c => c.filePath === target.filePath);
  if (sameFile.length > 0) return sameFile[0];
  const sameClass = candidates.filter(c => sharesContainingScope(target, c));
  if (sameClass.length > 0) return sameClass[0];
  return candidates[0] ?? null;
}

function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x !== 0n) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/**
 * Fetch continuity rows for a given symbol id, ordered by confidence desc.
 */
export function getContinuityForSymbol(
  store: Store, symbolId: number,
): Array<{
  previousSymbolKey: string;
  previousName: string;
  previousFile: string;
  confidence: number;
  matchReasons: string[];
}> {
  if (!store.hasV10()) return [];
  try {
    const rows = store.rawDb().prepare(`
      SELECT previous_symbol_key AS previousSymbolKey,
             previous_name AS previousName,
             previous_file AS previousFile,
             confidence, match_reasons AS matchReasons
      FROM symbol_history_continuity
      WHERE symbol_id = ?
      ORDER BY confidence DESC, id DESC
    `).all(symbolId) as Array<{
      previousSymbolKey: unknown; previousName: unknown; previousFile: unknown;
      confidence: unknown; matchReasons: unknown;
    }>;
    return rows.map(r => ({
      previousSymbolKey: String(r.previousSymbolKey),
      previousName: String(r.previousName ?? ''),
      previousFile: String(r.previousFile ?? ''),
      confidence: Number(r.confidence ?? 0),
      matchReasons: parseReasons(r.matchReasons),
    }));
  } catch { return []; }
}

function parseReasons(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}
