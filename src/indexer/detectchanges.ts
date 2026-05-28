import { Store } from '../db/store.js';
import { gitChangedFiles, fileDiffHunksSync, isGitRepo } from './git.js';
import type { SymbolRow } from '../types.js';

/**
 * Compute the blast radius of an uncommitted (or between-refs) diff. For each
 * changed file we identify the symbols whose line ranges overlap the diff
 * hunks, then expand by N levels of reverse callers (transitive callers,
 * because they're the code most likely to break).
 */

export interface ChangedSymbol {
  symbol: SymbolRow;
  hunkCount: number;
}

export interface DetectChangesResult {
  fromRef: string | null;
  toRef: string | null;
  changedFiles: Array<{ path: string; hunks: number; symbols: ChangedSymbol[] }>;
  /** Direct changed symbols (the inner symbols in `changedFiles`). */
  directlyChanged: SymbolRow[];
  /** Transitive callers of the directly-changed set (deduped). */
  transitivelyAffected: SymbolRow[];
  elapsedMs: number;
}

export function detectChanges(
  repoRoot: string, store: Store,
  options: { fromRef?: string; toRef?: string; callerDepth?: number } = {},
): DetectChangesResult {
  const start = Date.now();
  const callerDepth = options.callerDepth ?? 2;
  const fromRef = options.fromRef ?? null;
  const toRef = options.toRef ?? null;
  if (!isGitRepo(repoRoot)) {
    return { fromRef, toRef, changedFiles: [], directlyChanged: [], transitivelyAffected: [], elapsedMs: Date.now() - start };
  }
  const files = gitChangedFiles(repoRoot, fromRef ?? undefined, toRef ?? undefined);
  if (files.length === 0) {
    return { fromRef, toRef, changedFiles: [], directlyChanged: [], transitivelyAffected: [], elapsedMs: Date.now() - start };
  }
  const dbFiles = new Map(store.listFiles().map(f => [normalize(f.path), f.id]));
  const changedFiles: DetectChangesResult['changedFiles'] = [];
  const directIds = new Set<number>();
  for (const abs of files) {
    const fileId = dbFiles.get(normalize(abs));
    if (fileId === undefined) continue;
    const hunks = fileDiffHunksSync(repoRoot, abs, fromRef ?? undefined, toRef ?? undefined);
    if (hunks.length === 0) continue;
    // Convert 1-indexed git line ranges to 0-indexed Strata line ranges.
    const ranges: Array<[number, number]> = hunks.map(h => [
      Math.max(0, h.newStart - 1),
      Math.max(0, h.newStart - 1 + Math.max(0, h.newLines - 1)),
    ]);
    const syms = store.symbolsTouchingLines(fileId, ranges);
    for (const s of syms) directIds.add(s.id);
    changedFiles.push({
      path: abs,
      hunks: hunks.length,
      symbols: syms.map(s => ({ symbol: s, hunkCount: hunks.length })),
    });
  }
  const directly: SymbolRow[] = [];
  for (const id of directIds) {
    const s = store.getSymbolById(id);
    if (s) directly.push(s);
  }
  const transitiveIds = new Set<number>();
  for (const s of directly) {
    for (const id of store.reverseReachable(s.id, callerDepth)) {
      if (!directIds.has(id)) transitiveIds.add(id);
    }
  }
  const transitively: SymbolRow[] = [];
  for (const id of transitiveIds) {
    const s = store.getSymbolById(id);
    if (s) transitively.push(s);
  }
  transitively.sort((a, b) => b.pagerank - a.pagerank);
  return {
    fromRef,
    toRef,
    changedFiles,
    directlyChanged: directly,
    transitivelyAffected: transitively,
    elapsedMs: Date.now() - start,
  };
}

function normalize(p: string): string {
  const n = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
