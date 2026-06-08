# Pre-Edit Context

The best time to understand a change is before touching the code.

## Scenario

An agent needs to add idempotency to `chargeCard`. It should know:

| Question | Why it matters |
|---|---|
| Who calls it? | The change may affect more than the local file. |
| Which tests cover it? | Existing behavior should stay protected. |
| Is it on a route? | A regression may be user-facing. |
| Has it changed recently? | Recent fixes often hide important context. |

## One Call

```json
{ "symbol": "chargeCard" }
```

Call `seer_preflight`.

Trimmed response:

```json
{
  "symbol": {
    "qualifiedName": "billing.PaymentService.chargeCard",
    "file": "src/billing/payment.ts",
    "lineStart": 142,
    "kind": "method"
  },
  "callers": [
    { "name": "checkout", "file": "src/api/checkout.ts", "line": 88 },
    { "name": "retryFailedPayment", "file": "src/jobs/retry.ts", "line": 31 }
  ],
  "transitiveDependents": 9,
  "routeExposure": [
    { "method": "POST", "path": "/api/checkout" }
  ],
  "tests": [
    { "name": "charges a valid card", "file": "test/payment.spec.ts", "directness": "direct" }
  ],
  "risk": {
    "verdict": "high",
    "reasons": [
      "public route POST /api/checkout",
      "9 transitive dependents",
      "cyclomatic 14"
    ]
  }
}
```

## What The Agent Learns

| Signal | Read as |
|---|---|
| Public route | Treat this as user-facing behavior. |
| 9 transitive dependents | Check downstream callers before changing the contract. |
| One direct test | Add coverage for the new idempotency behavior. |
| Recent history | Read nearby commits if the change touches old bug-fix paths. |

## Diff Mode

For work already underway:

```json
{ "fromRef": "main", "toRef": "HEAD" }
```

Seer maps the diff to changed symbols and returns a preflight packet for each.

## CLI

```bash
seer preflight --symbol chargeCard
seer preflight --symbol chargeCard --file src/billing/payment.ts
seer preflight --from main --to HEAD --json
```
