# Change history

Generic MCP servers show file-level churn. Seer's differentiator is symbol-level
history: the commit blame chain for the exact function, method, or class, and
the blast radius of a diff mapped to symbols rather than line numbers.

## History for one symbol

```
seer_history { "symbol": "chargeCard" }
```

Trimmed response:

```json
{
  "symbol": "billing.PaymentService.chargeCard",
  "commits": [
    { "sha": "a1b2c3d", "date": "2026-04-18", "author": "Dana", "summary": "handle declined cards" },
    { "sha": "9f8e7d6", "date": "2026-02-02", "author": "Sam",  "summary": "add retry on timeout" },
    { "sha": "1122334", "date": "2025-11-20", "author": "Dana", "summary": "extract chargeCard from checkout" }
  ]
}
```

The last entry shows `chargeCard` was extracted out of `checkout` in November.
That is lineage a per-file blame would blur, because the code used to live in a
different function.

## Diff blast radius

When work is already underway, point Seer at the range:

```
seer_preflight { "fromRef": "main", "toRef": "HEAD" }
```

Trimmed response:

```json
{
  "changedSymbols": [
    {
      "name": "chargeCard",
      "file": "src/billing/payment.ts",
      "changeKind": "modified",
      "transitiveDependents": 9,
      "routeExposure": [{ "method": "POST", "path": "/api/checkout" }],
      "risk": { "verdict": "high" }
    },
    {
      "name": "formatAmount",
      "file": "src/billing/format.ts",
      "changeKind": "modified",
      "transitiveDependents": 31,
      "risk": { "verdict": "medium" }
    }
  ]
}
```

Seer translated the raw line diff into the two symbols you actually changed, then
told you `formatAmount` has 31 dependents, which is the kind of thing easy to
miss when a one-line format tweak looks harmless.

## Continuity across renames

If a symbol was recently renamed or moved and you want the evidence:

```
seer_continuity { "symbol": "chargeCard" }
```

This is advisory and confidence-labeled. It will not invent a link it cannot
justify by shape and scope similarity. For the authoritative cross-commit lineage
(across moves and renames), `seer_history` follows the file through git.

## From the CLI

```bash
seer symbol-history            # build the per-symbol history index (opt-in, once)
seer history chargeCard
seer continuity chargeCard
seer detect-changes --from main --to HEAD
```
