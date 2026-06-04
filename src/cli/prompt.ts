import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ClientId } from './init.js';

/**
 * Interactive `seer init` wizard.
 *
 * The non-interactive installer has to *guess* which agent you use, and when
 * the guess is wrong it writes config for clients you never asked for (the
 * classic "I installed for Antigravity and it also wrote .cursor/ and
 * .vscode/"). A guess is the wrong tool for a one-time setup step — so when a
 * human is at the keyboard we just ask. Everything here is opt-in and the
 * defaults are the safe choice, so mashing Enter does the sensible thing.
 *
 * Seer is a per-repo index: one agent owns a given checkout, so the primary
 * question is a SINGLE choice, not a multi-select. (Antigravity is the one
 * environment that can host several agent *extensions* inside it, so it gets a
 * follow-up multi-select; for every other choice we already know the answer.)
 *
 * This module only collects answers. It performs no file writes itself; the
 * caller feeds the result back into the pure `runInit` planner. That keeps the
 * installer testable (tests drive `runInit` directly and never see a prompt).
 */

/** Human-facing client catalogue, in the order we present it. */
const CLIENT_MENU: Array<{ id: ClientId; label: string; hint: string }> = [
  { id: 'antigravity', label: 'Google Antigravity',  hint: 'IDE / CLI' },
  { id: 'claude',      label: 'Claude Code',          hint: 'CLI or IDE extension' },
  { id: 'codex',       label: 'OpenAI Codex',         hint: 'CLI or IDE extension' },
  { id: 'cursor',      label: 'Cursor',               hint: '' },
  { id: 'gemini',      label: 'Gemini CLI',           hint: '' },
  { id: 'vscode',      label: 'VS Code',              hint: 'Copilot / native MCP' },
  { id: 'windsurf',    label: 'Windsurf',             hint: 'user-level config' },
];

/** Agent extensions that can run *inside* Antigravity and read their own MCP config. */
const ANTIGRAVITY_EXTENSIONS: Array<{ id: ClientId; label: string }> = [
  { id: 'claude', label: 'Claude extension' },
  { id: 'codex',  label: 'Codex extension' },
  { id: 'gemini', label: 'Gemini extension' },
];

export interface WizardAnswers {
  clients: ClientId[];
  index: boolean;
  symbolHistory: boolean;
}

/**
 * Minimal I/O surface the wizard needs. Real runs back this with readline; tests
 * inject a scripted version so the full branching is verifiable without a TTY
 * (faking isTTY over a pipe makes readline drain the whole buffer at once).
 */
export interface PromptIO {
  question(prompt: string): Promise<string>;
  log(line: string): void;
}

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** Parse "1,3" / "1 3" / "1, 3" into the matching menu ids; ignores out-of-range.
 *  Used by the Antigravity-extensions multi-select (you can run several at once). */
export function parseSelection<T>(raw: string, menu: T[]): T[] {
  const picks = new Set<number>();
  for (const tok of raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    const n = parseInt(tok, 10);
    if (!isNaN(n) && n >= 1 && n <= menu.length) picks.add(n - 1);
  }
  return [...picks].sort((a, b) => a - b).map((i) => menu[i]);
}

/** Parse a single menu number; returns null for empty / non-numeric / out-of-range.
 *  The primary "which agent" question is single-choice (one agent per repo). */
export function parseSingleSelection<T>(raw: string, menu: T[]): T | null {
  const n = parseInt(raw.trim(), 10);
  if (!isNaN(n) && n >= 1 && n <= menu.length && String(n) === raw.trim()) return menu[n - 1];
  return null;
}

async function confirm(io: PromptIO, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await io.question(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** Build the default readline-backed I/O for a real interactive run. A SIGINT
 *  (Ctrl-C) aborts the in-flight question via an AbortController instead of
 *  letting Node throw a raw AbortError stack trace — runInitWizard catches the
 *  abort and exits cleanly. The listener also suppresses the default
 *  process-kill so the cancel is graceful. */
function readlineIO(): { io: PromptIO; close: () => void } {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  rl.on('SIGINT', onSigint);
  return {
    io: {
      question: (q) => rl.question(q, { signal: ac.signal }),
      log: (l) => console.log(l),
    },
    close: () => { rl.off('SIGINT', onSigint); rl.close(); },
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error
    && (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR');
}

/**
 * Run the wizard. `detected` is the installer's best guess at the active client
 * (a single id, or null when it can't tell); it pre-selects the menu so the
 * common case is one Enter. Returns null when the user bails (no/invalid
 * selection, or Ctrl-C).
 *
 * Pass `io` to drive it programmatically (tests); omit it for a real terminal.
 */
export async function runInitWizard(detected: ClientId | null, io?: PromptIO): Promise<WizardAnswers | null> {
  const backing = io ? null : readlineIO();
  const prompt = io ?? backing!.io;
  try {
    prompt.log('\nSeer setup\n');

    // 1 ─ Which agent? SINGLE choice: a Seer index belongs to one repo, and one
    // agent owns that checkout. (Power users wiring several agents can still pass
    // --client a,b.) We pre-select the detected agent so Enter accepts it.
    prompt.log('Which AI agent are you setting up Seer for?');
    for (let i = 0; i < CLIENT_MENU.length; i++) {
      const c = CLIENT_MENU[i];
      const tag = detected === c.id ? '  (detected)' : '';
      const hint = c.hint ? ` — ${c.hint}` : '';
      prompt.log(`  ${i + 1}) ${c.label}${hint}${tag}`);
    }
    const detectedIdx = detected ? CLIENT_MENU.findIndex((c) => c.id === detected) + 1 : 0;

    let primary: ClientId | null = null;
    for (let attempt = 0; attempt < 5 && !primary; attempt++) {
      const promptText = detectedIdx > 0
        ? `Enter a number [${detectedIdx}]: `
        : 'Enter a number (Enter to cancel): ';
      const raw = (await prompt.question(promptText)).trim();
      if (!raw) {
        if (detectedIdx > 0) { primary = CLIENT_MENU[detectedIdx - 1].id; break; }
        prompt.log('\nNo agent selected — nothing to set up. Re-run when ready.\n');
        return null;
      }
      primary = parseSingleSelection(raw, CLIENT_MENU)?.id ?? null;
      if (!primary) prompt.log(`  "${raw}" is not on the list — enter a single number 1-${CLIENT_MENU.length}.`);
    }
    if (!primary) {
      prompt.log('\nNo valid selection — nothing to set up. Re-run when ready.\n');
      return null;
    }

    const picked: ClientId[] = [primary];

    // 2 ─ Antigravity is the one host that runs other agent extensions, each with
    // its own MCP config. Offer to wire those too (multi-select). For every other
    // primary choice this question doesn't apply, so we skip it entirely.
    if (primary === 'antigravity') {
      prompt.log('\nAntigravity can also host Claude, Codex, and Gemini agent extensions.');
      prompt.log('Set up Seer for any of those too? (each reads its own MCP config)');
      ANTIGRAVITY_EXTENSIONS.forEach((e, i) => prompt.log(`  ${i + 1}) ${e.label}`));
      const rawExt = (await prompt.question('Enter number(s), comma-separated, or Enter to skip []: ')).trim();
      if (rawExt) {
        for (const e of parseSelection(rawExt, ANTIGRAVITY_EXTENSIONS)) {
          if (!picked.includes(e.id)) picked.push(e.id);
        }
      }
    }

    // 3 ─ Index now? (recommended)
    prompt.log('');
    const index = await confirm(
      prompt,
      'Index this repo now? Builds the local map so the first agent query is instant. (recommended)',
      true,
    );

    // 4 ─ Symbol history? Only meaningful if we are indexing. Off by default —
    // a full history walk is slow on large repos and is fully optional.
    let symbolHistory = false;
    if (index) {
      symbolHistory = await confirm(
        prompt,
        'Also index per-symbol git history? Powers seer_history, but is slow on large repos. (not recommended for big repos)',
        false,
      );
    }

    return { clients: picked, index, symbolHistory };
  } catch (err) {
    if (isAbortError(err)) {
      prompt.log('\nSetup cancelled.\n');
      return null;
    }
    throw err;
  } finally {
    backing?.close();
  }
}
