/**
 * Shared single-line TTY progress rendering.
 *
 * Extracted from the indexer so the symbol-history build (and any other long
 * pass) renders the same in-place bar. Every function here NO-OPs when stdout is
 * not a TTY, so piped/redirected output stays clean — callers that still want
 * non-TTY feedback should emit their own throttled plain-text lines.
 */

/**
 * Render an in-place progress bar on the current stdout line. Writes no trailing
 * newline (the `\r` returns the cursor to the line start) so repeated calls
 * overwrite in place; the caller writes a newline when the phase finishes.
 * No-op on a non-TTY stdout.
 */
export function writeProgress(current: number, total: number, label: string): void {
  if (!process.stdout.isTTY) return;
  const width = 28;
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pctStr = Math.round(pct * 100).toString().padStart(3);
  const short = label.length > 35 ? '…' + label.slice(-34) : label.padEnd(35);
  process.stdout.write(`\r  [${bar}] ${pctStr}% (${current}/${total}) ${short}`);
}

/**
 * Clear the current progress line so a following log line starts clean. No-op on
 * a non-TTY stdout. Width covers the bar + counters + a label column.
 */
export function clearProgress(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\r' + ' '.repeat(72) + '\r');
}
