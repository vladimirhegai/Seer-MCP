/**
 * Simple iterative PageRank over the symbol call graph.
 * Follows the standard damping-factor formulation used by Aider's repo-map.
 */
export function computePageRank(
  symbolIds: number[],
  edges: Array<{ from: number; to: number }>,
  iterations = 20,
  damping = 0.85,
): Map<number, number> {
  const n = symbolIds.length;
  if (n === 0) return new Map();

  const initial = 1.0 / n;
  const ranks = new Map<number, number>(symbolIds.map(id => [id, initial]));

  // outgoing edges per node (deduped — out-degree counts distinct targets)
  const outgoing = new Map<number, Set<number>>();
  for (const id of symbolIds) outgoing.set(id, new Set());

  // incoming edges per node (deduped — each distinct (from→to) contributes once,
  // regardless of how many call sites exist between the two symbols)
  const incoming = new Map<number, Set<number>>();
  for (const id of symbolIds) incoming.set(id, new Set());

  for (const { from, to } of edges) {
    if (outgoing.has(from) && incoming.has(to)) {
      outgoing.get(from)!.add(to);
      incoming.get(to)!.add(from);
    }
  }

  const baseRank = (1 - damping) / n;

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<number, number>();

    for (const id of symbolIds) {
      let rank = baseRank;
      for (const fromId of incoming.get(id) ?? []) {
        const outDeg = outgoing.get(fromId)!.size;
        if (outDeg > 0) {
          rank += damping * (ranks.get(fromId)! / outDeg);
        }
      }
      next.set(id, rank);
    }

    for (const [id, r] of next) ranks.set(id, r);
  }

  return ranks;
}
