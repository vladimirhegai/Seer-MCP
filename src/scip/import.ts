import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Store } from '../db/store.js';
import type { SymbolDef, SymbolKind } from '../types.js';
import { ScipIndex, ScipSymbol } from './format.js';

export interface ScipImportOptions {
  /** Workspace root — used to resolve SCIP relativePaths to absolute paths. */
  repoRoot: string;
  /** Logger; defaults to no-op. */
  log?: (msg: string) => void;
  /**
   * Skip ALL inserts for files that aren't already indexed by tree-sitter.
   * Default true: SCIP precision is meant to enhance the existing index, not
   * to introduce phantom symbols for files Seer can't see (e.g. a SCIP that
   * covers `vendor/` we deliberately skipped). Set false to widen.
   */
  requireFileInIndex?: boolean;
}

export interface ScipImportResult {
  path: string;
  sha256: string;
  tool: string | null;
  documentsProcessed: number;
  symbolsInserted: number;
  symbolsMerged: number;
  edgesInserted: number;
  filesMissing: number;
  elapsedMs: number;
}

/**
 * Import a SCIP index into the Store, layering precise SCIP symbols and
 * references over the existing tree-sitter graph. Tree-sitter rows are never
 * deleted; SCIP symbols with the same file/line/kind/qualified-name as an
 * existing row reuse its id (and the existing row is re-labeled 'scip-merge').
 *
 * The import is idempotent on the (path, sha256) pair: re-importing the exact
 * same file is a no-op. Re-importing the same path with new content clears
 * the SCIP-sourced rows for that path first.
 */
export async function importScip(
  scipPath: string, store: Store, options: ScipImportOptions,
): Promise<ScipImportResult> {
  const start = Date.now();
  const log = options.log ?? (() => { /* */ });
  const abs = path.resolve(scipPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`SCIP index not found: ${abs}`);
  }
  const content = fs.readFileSync(abs);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  // Idempotency check — same path + sha = already imported, return a cheap
  // no-op result.
  if (store.hasScipImport(abs, sha)) {
    log(`SCIP ${path.basename(abs)} already imported (sha ${sha.slice(0, 8)}); skipping`);
    return {
      path: abs, sha256: sha, tool: null,
      documentsProcessed: 0, symbolsInserted: 0, symbolsMerged: 0, edgesInserted: 0,
      filesMissing: 0, elapsedMs: Date.now() - start,
    };
  }

  // Wipe SCIP rows from THIS exact path so re-imports don't accumulate.
  // Other SCIP layers stay untouched — clearScipProvenance(path) is scoped
  // to the path's scip_imports.id.
  store.clearScipProvenance(abs);

  // Currently we only parse the JSON envelope. Binary .scip support can be
  // added later by piping through a protobuf decoder; the rest of the
  // pipeline below stays unchanged because it works against the parsed
  // ScipIndex shape.
  let scip: ScipIndex;
  try {
    scip = JSON.parse(content.toString('utf-8')) as ScipIndex;
  } catch (err) {
    throw new Error(`Failed to parse SCIP JSON ${abs}: ${(err as Error).message}`);
  }

  // Map repo-relative paths → file_id by matching against the indexer's view.
  const allFiles = store.listFiles();
  const fileByRel = new Map<string, number>();
  for (const f of allFiles) {
    fileByRel.set(normalizePath(f.relPath), f.id);
  }
  const requireFileInIndex = options.requireFileInIndex ?? true;

  let documentsProcessed = 0;
  let symbolsInserted = 0;
  let symbolsMerged = 0;
  let edgesInserted = 0;
  let filesMissing = 0;

  // Record the import FIRST so we have an id to link every symbol/edge back
  // to. Counts are zero now and patched up at the end — the row exists from
  // the moment of insertion so scip_import_id foreign keys are always valid.
  const scipImportId = store.recordScipImport(
    abs, sha, scip.tool ?? null, scip.projectRoot ?? options.repoRoot,
    0, 0,
  );

  // Pass 1: insert SCIP symbols, keep a (scipSymbolId → storeSymbolId) map.
  const idMap = new Map<string, number>();
  // Track per-file definition occurrences so pass 2 can resolve references.
  store.rawDb().exec('BEGIN');
  try {
    for (const doc of scip.documents) {
      const rel = normalizePath(doc.relativePath);
      const fileId = fileByRel.get(rel);
      if (fileId == null) {
        if (requireFileInIndex) {
          filesMissing++;
          continue;
        }
      }
      documentsProcessed++;

      const fid = fileId ?? -1;
      if (fid < 0) continue;
      for (const sym of doc.symbols) {
        const def = scipSymbolToSymbolDef(sym);
        const { id, merged } = store.insertOrMergeScipSymbol(fid, def, scipImportId);
        idMap.set(sym.symbolId, id);
        if (merged) symbolsMerged++;
        else symbolsInserted++;
      }
    }

    // Pass 2: insert reference edges. We need both ends in the idMap, so any
    // reference whose target wasn't defined in this SCIP doc (cross-package
    // refs) is skipped. For each reference occurrence inside a function/
    // method's range we attribute the edge to that enclosing symbol — same
    // strategy tree-sitter uses for call-edge resolution.
    for (const doc of scip.documents) {
      const rel = normalizePath(doc.relativePath);
      const fileId = fileByRel.get(rel);
      if (fileId == null) continue;

      // Build a per-file ordered list of (definitionSymbolId, range) so we
      // can attribute references to the smallest enclosing definition.
      const localDefs: Array<{ id: number; symbolId: string; startLine: number; endLine: number }> = [];
      for (const sym of doc.symbols) {
        const storeId = idMap.get(sym.symbolId);
        if (storeId == null) continue;
        localDefs.push({
          id: storeId,
          symbolId: sym.symbolId,
          startLine: sym.range.startLine,
          endLine: sym.range.endLine,
        });
      }
      // Sort by line range size ascending so the smallest enclosing def wins.
      localDefs.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));

      for (const occ of doc.occurrences) {
        if (occ.role !== 'reference') continue;
        const targetId = idMap.get(occ.symbolId);
        if (targetId == null) continue;
        // Find smallest enclosing local definition.
        let fromId: number | null = null;
        for (const d of localDefs) {
          if (occ.range.startLine >= d.startLine && occ.range.startLine <= d.endLine) {
            fromId = d.id; break;
          }
        }
        if (fromId == null) continue;
        // Use the displayName of the target symbol so to_name stays consistent
        // with tree-sitter's edge representation.
        const targetSymbol = doc.symbols.find(s => s.symbolId === occ.symbolId);
        const toName = targetSymbol?.displayName ?? occ.symbolId;
        store.insertScipEdge(fromId, targetId, toName, 'call', occ.range.startLine, scipImportId);
        edgesInserted++;
      }
    }
    store.rawDb().exec('COMMIT');
  } catch (err) {
    store.rawDb().exec('ROLLBACK');
    throw err;
  }

  // Patch the counts now that we know them — keeps the layer self-describing
  // for the bundle manifest.
  store.recordScipImport(
    abs, sha, scip.tool ?? null, scip.projectRoot ?? options.repoRoot,
    symbolsInserted + symbolsMerged, edgesInserted,
  );

  log(`SCIP ${path.basename(abs)}: ${documentsProcessed} docs, ${symbolsInserted} new, ${symbolsMerged} merged, ${edgesInserted} edges (${filesMissing} files missing)`);

  return {
    path: abs, sha256: sha, tool: scip.tool ?? null,
    documentsProcessed, symbolsInserted, symbolsMerged, edgesInserted,
    filesMissing, elapsedMs: Date.now() - start,
  };
}

function scipSymbolToSymbolDef(sym: ScipSymbol): SymbolDef {
  // SCIP doesn't carry symbol_role; assume 'definition'.
  return {
    name: sym.displayName,
    qualifiedName: sym.qualifiedName,
    kind: sym.kind as SymbolKind,
    lineStart: sym.range.startLine,
    lineEnd: sym.range.endLine,
    colStart: sym.range.startCharacter,
    colEnd: sym.range.endCharacter,
    signature: sym.signature,
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
