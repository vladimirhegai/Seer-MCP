/**
 * Tiny opt-in phase profiler. Gated entirely on the `SEER_PROFILE` env var so
 * it is a no-op (no allocations, no Map writes) in normal runs. When enabled it
 * accumulates wall-clock time per named phase and can dump a sorted report to
 * stderr. Used to find indexing / symbol-history bottlenecks without dragging a
 * full tracing dependency into the build.
 *
 * Usage:
 *   SEER_PROFILE=1 seer index <repo>
 *   const end = profileStart('resolveEdges'); ... ; end();
 *   profileReport('index');
 */

const ENABLED = typeof process !== 'undefined'
  && process.env != null
  && process.env.SEER_PROFILE != null
  && process.env.SEER_PROFILE !== '0'
  && process.env.SEER_PROFILE !== '';

interface PhaseStat { totalMs: number; calls: number; }

const phases = new Map<string, PhaseStat>();
const noopEnd = (): void => { /* no-op */ };

export function profileEnabled(): boolean {
  return ENABLED;
}

/** Start timing a phase; returns a function that stops it and records elapsed. */
export function profileStart(name: string): () => void {
  if (!ENABLED) return noopEnd;
  const t0 = performance.now();
  return () => {
    const dt = performance.now() - t0;
    const cur = phases.get(name);
    if (cur) { cur.totalMs += dt; cur.calls++; }
    else phases.set(name, { totalMs: dt, calls: 1 });
  };
}

/** Record an already-measured duration (ms) against a phase. */
export function profileAdd(name: string, ms: number): void {
  if (!ENABLED) return;
  const cur = phases.get(name);
  if (cur) { cur.totalMs += ms; cur.calls++; }
  else phases.set(name, { totalMs: ms, calls: 1 });
}

/** Dump the accumulated phases (sorted slowest-first) to stderr, then reset. */
export function profileReport(label: string): void {
  if (!ENABLED || phases.size === 0) return;
  const rows = [...phases.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  const total = rows.reduce((s, [, v]) => s + v.totalMs, 0);
  process.stderr.write(`\n-- SEER_PROFILE [${label}] --------------------------\n`);
  for (const [name, v] of rows) {
    const pct = total > 0 ? (v.totalMs / total) * 100 : 0;
    process.stderr.write(
      `  ${name.padEnd(30)} ${(v.totalMs).toFixed(0).padStart(9)} ms  ${pct.toFixed(1).padStart(5)}%  (${v.calls}x)\n`,
    );
  }
  process.stderr.write(`  ${'TOTAL (sum of phases)'.padEnd(30)} ${total.toFixed(0).padStart(9)} ms\n`);
  process.stderr.write(`----------------------------------------------------\n`);
  phases.clear();
}
