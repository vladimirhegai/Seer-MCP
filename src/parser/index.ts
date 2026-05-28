import Parser from 'web-tree-sitter';
import path from 'path';
import type { FileExtraction, Language } from '../types.js';
import type { LanguageExtractor } from './walker.js';
import { walkTree } from './walker.js';
import { pythonExtractor }     from './languages/python.js';
import { typescriptExtractor } from './languages/typescript.js';
import { goExtractor }         from './languages/go.js';
import { javaExtractor }       from './languages/java.js';
import { rustExtractor }       from './languages/rust.js';
import { cppExtractor }        from './languages/cpp.js';
import { csharpExtractor }     from './languages/csharp.js';

// ── Extension → language mapping ───────────────────────────────────────────────

const EXT_TO_LANGUAGE: Record<string, Language> = {
  '.py': 'python', '.pyw': 'python',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
  // C source files use the dedicated C grammar with the C++ extractor's shared
  // C-family symbol logic. `.h` remains ambiguous between C and C++, so we keep
  // headers on the C++ grammar by default.
  '.c': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp', '.h++': 'cpp', '.h': 'cpp',
  '.cs': 'csharp',
};

export function detectLanguage(filePath: string): Language | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}

/**
 * Map a file extension to the specific WASM grammar to load. Most languages
 * have one grammar, but TS/JS are split:
 *   .tsx → tsx grammar (typescript + JSX)
 *   .jsx → javascript grammar (which handles JSX natively)
 *   .ts  → typescript grammar (no JSX)
 */
function grammarForExtension(ext: string): string | null {
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx' || ext === '.mjs' || ext === '.cjs' || ext === '.js') return 'javascript';
  if (ext === '.ts') return 'typescript';
  const lang = EXT_TO_LANGUAGE[ext];
  if (!lang) return null;
  return GRAMMAR_NAME[lang];
}

// ── Parser singleton + language cache ──────────────────────────────────────────
//
// web-tree-sitter shares ONE WebAssembly module across all `Parser` instances.
// When tree-sitter aborts inside WASM (printing "Aborted()" to stderr — usually
// from a memory exhaustion on a pathological input), the WASM module is left
// poisoned and every subsequent parse fails. Creating a fresh `new Parser()`
// does NOT recover, because the underlying module is shared and broken.
//
// The recovery path is to throw away the entire WASM runtime and re-initialize:
// re-call `Parser.init()` and reload every grammar from disk. That's what
// `resetWasmRuntime` does. It's expensive (~100-300ms) but only runs after a
// real failure — the per-file size cap keeps it rare.

let _initialized = false;
let _parser: Parser | null = null;
const _languages = new Map<string, Parser.Language>();

async function ensureReady(): Promise<void> {
  if (_initialized) return;
  await Parser.init();
  _initialized = true;
}

function getParser(): Parser {
  if (!_parser) _parser = new Parser();
  return _parser;
}

async function loadLanguage(grammarName: string): Promise<Parser.Language> {
  await ensureReady();
  const cached = _languages.get(grammarName);
  if (cached) return cached;

  // tree-sitter-wasms uses underscores in some filenames (e.g. c_sharp). The
  // `grammarName` we pass through is the canonical WASM-filename suffix.
  const wasmDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  const wasmPath = path.join(wasmDir, 'out', `tree-sitter-${grammarName}.wasm`);
  const lang = await Parser.Language.load(wasmPath);
  _languages.set(grammarName, lang);
  return lang;
}

let _wasmResets = 0;
let _consecutiveFailures = 0;
const RESET_AFTER_N_FAILURES = 3;

function noteParseSuccess(): void {
  _consecutiveFailures = 0;
}

async function noteParseFailureMaybeReset(): Promise<void> {
  _consecutiveFailures++;
  if (_consecutiveFailures >= RESET_AFTER_N_FAILURES) {
    _consecutiveFailures = 0;
    try { await resetWasmRuntime(); } catch { /* best effort */ }
  }
}

async function resetWasmRuntime(): Promise<void> {
  _wasmResets++;
  const grammarNames = Array.from(_languages.keys());
  _initialized = false;
  _parser = null;
  _languages.clear();
  await ensureReady();
  for (const name of grammarNames) {
    await loadLanguage(name);
  }
}

/** How many times the WASM module had to be hard-reset. Exposed for stats. */
export function wasmResetCount(): number {
  return _wasmResets;
}

// ── Extractor registry ─────────────────────────────────────────────────────────

// JavaScript and TypeScript share the TypeScript extractor but need different
// WASM grammars (and .tsx needs the tsx variant).
const EXTRACTORS: Record<Language, LanguageExtractor> = {
  python:     pythonExtractor,
  typescript: typescriptExtractor,
  javascript: { ...typescriptExtractor, languageName: 'javascript' },
  go:         goExtractor,
  java:       javaExtractor,
  rust:       rustExtractor,
  c:          { ...cppExtractor, languageName: 'c', extensions: ['.c'] },
  cpp:        cppExtractor,
  csharp:     csharpExtractor,
};

// Default grammar for each language (used when there's no per-extension override
// in `grammarForExtension`). Note the underscore in `c_sharp` matches the WASM
// filename `tree-sitter-c_sharp.wasm`.
const GRAMMAR_NAME: Record<Language, string> = {
  python:     'python',
  typescript: 'typescript',
  javascript: 'javascript',
  go:         'go',
  java:       'java',
  rust:       'rust',
  c:          'c',
  cpp:        'cpp',
  csharp:     'c_sharp',
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Parse a file and return the extracted symbols, references, and imports.
 * Returns null on parse failure (caller decides whether to warn).
 *
 * Takes the file path (not just the language) so we can route .tsx → the tsx
 * grammar variant, which is required to parse JSX.
 */
export async function parseFile(
  content: string,
  filePathOrLanguage: string,
  languageOverride?: Language,
): Promise<FileExtraction | null> {
  try {
    // Back-compat: callers used to pass (content, language). New callers pass
    // (content, filePath). We detect by checking if it's a known Language.
    let language: Language | null;
    let ext: string;
    if (languageOverride) {
      language = languageOverride;
      ext = path.extname(filePathOrLanguage).toLowerCase();
    } else if (isLanguageString(filePathOrLanguage)) {
      // Legacy two-arg form: parseFile(content, language)
      language = filePathOrLanguage as Language;
      // No file path → use the language's default grammar
      ext = '';
    } else {
      language = detectLanguage(filePathOrLanguage);
      ext = path.extname(filePathOrLanguage).toLowerCase();
    }

    if (!language) return null;

    const grammarName = ext ? grammarForExtension(ext) ?? GRAMMAR_NAME[language] : GRAMMAR_NAME[language];
    const lang = await loadLanguage(grammarName);
    const parser = getParser();
    parser.setLanguage(lang);
    // Cap parse time at 10s per file. tree-sitter aborts internally on
    // truly pathological inputs (returning null without poisoning), which
    // we'd much rather have than the WASM heap exhaustion that comes from
    // letting it run indefinitely.
    try {
      // setTimeoutMicros may not exist on older web-tree-sitter versions.
      (parser as unknown as { setTimeoutMicros?: (us: number) => void })
        .setTimeoutMicros?.(10_000_000);
    } catch { /* best effort */ }
    const tree = parser.parse(content);
    if (!tree) {
      await noteParseFailureMaybeReset();
      return null;
    }
    const extractor = EXTRACTORS[language];
    try {
      const result = walkTree(tree.rootNode, extractor);
      noteParseSuccess();
      return result;
    } finally {
      // CRITICAL: tree-sitter trees hold WASM-allocated memory. If we don't
      // explicitly delete them, every parse leaks and the WASM heap fills up.
      // At small scale this is invisible; on a 100k+ file codebase like
      // Unreal it cascades into the heap aborting and poisoning all
      // subsequent parses. This single line is the difference between
      // "indexer works" and "indexer falls over on big codebases."
      try { (tree as { delete?: () => void }).delete?.(); } catch { /* */ }
    }
  } catch (err) {
    // After a WASM Abort the entire shared WASM module may be poisoned, not
    // just our Parser instance. Reset is opportunistic — only kicks in after
    // a few failures in a row, so single legit parse errors don't trigger
    // an expensive reload.
    await noteParseFailureMaybeReset();
    return null;
  }
}

function isLanguageString(s: string): boolean {
  return s in GRAMMAR_NAME;
}

export { detectLanguage as getLanguage };
