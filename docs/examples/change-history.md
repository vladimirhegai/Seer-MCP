# Change History

Seer tracks history at the symbol level. That means an agent can inspect the
commits that touched a function, method, or class instead of reading file-level
churn alone.

## Build History

The full history index is opt-in:

```bash
seer symbol-history
```

Single-symbol history can also build a small scoped slice on first use.

## One Symbol

```json
{ "symbol": "chargeCard" }
```

Call `seer_history`.

Trimmed response:

```json
{
  "symbol": "billing.PaymentService.chargeCard",
  "commits": [
    { "sha": "a1b2c3d", "date": "2026-04-18", "summary": "handle declined cards" },
    { "sha": "9f8e7d6", "date": "2026-02-02", "summary": "add retry on timeout" },
    { "sha": "1122334", "date": "2025-11-20", "summary": "extract chargeCard from checkout" }
  ]
}
```

## Diff Blast Radius

```json
{ "fromRef": "main", "toRef": "HEAD" }
```

Call `seer_preflight`.

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

## Continuity

Use `seer_continuity` for rename or move evidence in the current tree:

```json
{ "symbol": "chargeCard" }
```

The result is advisory and confidence-labeled. For cross-commit lineage, use
`seer_history`.

## CLI

```bash
seer symbol-history
seer history chargeCard
seer continuity chargeCard
seer detect-changes --from main --to HEAD
```
