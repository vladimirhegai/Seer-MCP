/**
 * Deterministic skeleton renderer (AI-agent optimization §3).
 *
 * Renders a file as a *structural skeleton*: every symbol's header (signature)
 * is kept, bodies are collapsed to a fold marker carrying the exact collapsed
 * line count. This is deterministic SOURCE ELISION — not summarization — so it
 * stays inside Seer's zero-AI / reproducible contract: the same DB + same file
 * bytes always render byte-identical output.
 *
 * Inputs are entirely owned by Seer already: per-symbol line ranges and kinds
 * from the index, plus the file bytes on disk (read only for the header lines
 * and an optional focused body). Nesting is reconstructed from line-range
 * containment, so it works for every language without per-grammar logic.
 */
import fs from 'fs';
import type { Store } from '../db/store.js';
import type { SymbolRow } from '../types.js';

export interface SkeletonResult {
  ok: boolean;
  file?: string;
  relPath?: string;
  language?: string;
  symbolCount?: number;
  focus?: string | null;
  skeleton?: string;
  reason?: string;
}

/** Kinds whose bodies are worth collapsing into a fold marker. */
const BODY_KINDS = new Set(['function', 'method', 'constructor']);

interface Node {
  row: SymbolRow;
  children: Node[];
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** Find the indexed file row best matching `file` (abs path, rel_path, or a
 *  trailing path fragment on a `/` boundary). */
function matchFile(
  store: Store,
  file: string,
): { id: number; path: string; relPath: string; language: string } | null {
  const target = norm(file);
  const files = store.listFiles();
  // Exact first, then boundary-aligned suffix — mirrors getDefinition's rule.
  const exact = files.find(f => norm(f.path) === target || norm(f.relPath) === target);
  if (exact) return exact;
  const frag = target.startsWith('/') ? target : '/' + target;
  return (
    files.find(f => norm(f.path).endsWith(frag) || norm(f.relPath).endsWith(frag)) ?? null
  );
}

/** Build the containment forest from line ranges (tightest-encloser parenting). */
function buildForest(rows: SymbolRow[]): Node[] {
  // Sort by start asc, then by end desc so a container precedes its members.
  const sorted = [...rows].sort(
    (a, b) => a.lineStart - b.lineStart || b.lineEnd - a.lineEnd || a.id - b.id,
  );
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const row of sorted) {
    const node: Node = { row, children: [] };
    // Pop until the top of the stack encloses this node.
    while (
      stack.length > 0 &&
      !(stack[stack.length - 1].row.lineStart <= row.lineStart &&
        row.lineEnd <= stack[stack.length - 1].row.lineEnd &&
        stack[stack.length - 1].row !== row)
    ) {
      stack.pop();
    }
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

/** Pick the display header for a symbol: prefer the stored signature, else the
 *  first source line of its declaration, trimmed of trailing block openers. */
function headerFor(row: SymbolRow, lines: string[]): string {
  const sig = row.signature?.trim();
  if (sig) return sig.replace(/\s*\{\s*$/, '').trim();
  const raw = lines[row.lineStart] ?? '';
  return raw.trim().replace(/\s*\{\s*$/, '').trim();
}

function render(
  node: Node,
  lines: string[],
  depth: number,
  focus: string | null,
  out: string[],
): void {
  const { row } = node;
  const indent = '  '.repeat(depth);
  const span = `[L${row.lineStart + 1}-${row.lineEnd + 1}]`;
  const header = headerFor(row, lines);
  const isFocus =
    focus != null && (row.name === focus || row.qualifiedName === focus);

  if (isFocus) {
    // Expanded: show the real source slice verbatim (the agent asked for it).
    out.push(`${indent}${header}  ${span}  ◀ focus`);
    const body = lines.slice(row.lineStart, row.lineEnd + 1);
    for (const l of body) out.push(`${indent}  ${l}`);
    return;
  }

  if (node.children.length > 0) {
    // Container: header, then recurse into members.
    out.push(`${indent}${header}  ${span}`);
    for (const child of node.children) render(child, lines, depth + 1, focus, out);
    return;
  }

  // Leaf. Collapse a real body into a fold marker with the exact line count.
  const bodyLines = row.lineEnd - row.lineStart - 1;
  if (BODY_KINDS.has(row.kind) && bodyLines > 0) {
    out.push(`${indent}${header}  ${span}  { … ${bodyLines} lines … }`);
  } else {
    out.push(`${indent}${header}  ${span}`);
  }
}

export function buildSkeleton(
  store: Store,
  file: string,
  opts: { focusSymbol?: string } = {},
): SkeletonResult {
  const match = matchFile(store, file);
  if (!match) return { ok: false, reason: `no indexed file matching "${file}"` };

  let src: string;
  try {
    src = fs.readFileSync(match.path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `cannot read ${match.path}: ${(err as Error).message}` };
  }
  // Strip a UTF-8 BOM so line 1 matches the indexer's view.
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.split(/\r?\n/);

  const rows = store.listSymbolsInFile(match.path, 5000);
  const focus = opts.focusSymbol ?? null;
  const forest = buildForest(rows);

  const out: string[] = [];
  out.push(`${match.relPath}  (${match.language}, ${rows.length} symbols)`);
  out.push('─'.repeat(Math.min(60, Math.max(20, match.relPath.length + 16))));
  for (const root of forest) render(root, lines, 0, focus, out);
  if (rows.length === 0) out.push('(no symbols indexed in this file)');

  return {
    ok: true,
    file: match.path,
    relPath: match.relPath,
    language: match.language,
    symbolCount: rows.length,
    focus,
    skeleton: out.join('\n'),
  };
}
