# Pre-edit context

The single most useful thing Seer does: tell an agent what a change will touch
*before* it makes it.

## The problem

An agent asked to "add idempotency to `chargeCard`" usually starts by grepping
for `chargeCard`, opening the file, grepping for callers, opening those, hunting
for tests, and maybe checking git blame. That is six to ten tool calls and a lot
of tokens, and it still misses the transitive dependents and the risk.

## One call instead

```
seer_preflight { "symbol": "chargeCard" }
```

Trimmed response:

```json
{
  "symbol": {
    "name": "chargeCard",
    "qualifiedName": "billing.PaymentService.chargeCard",
    "file": "src/billing/payment.ts",
    "lineStart": 142,
    "kind": "method"
  },
  "callers": [
    { "name": "checkout", "file": "src/api/checkout.ts", "line": 88 },
    { "name": "retryFailedPayment", "file": "src/jobs/retry.ts", "line": 31 }
  ],
  "callerCount": 2,
  "transitiveDependents": 9,
  "routeExposure": [
    { "method": "POST", "path": "/api/checkout", "framework": "express" }
  ],
  "tests": [
    { "name": "charges a valid card", "file": "test/payment.spec.ts", "directness": "direct" }
  ],
  "history": [
    { "sha": "a1b2c3d", "date": "2026-04-18", "summary": "handle declined cards" }
  ],
  "risk": {
    "verdict": "high",
    "reasons": ["sits on public route POST /api/checkout", "9 transitive dependents", "cyclomatic 14"]
  }
}
```

## Why this matters

The agent now knows, in one shot, that `chargeCard`:

- is reached from a public checkout endpoint, so a regression is user-facing,
- has 9 downstream dependents, so the blast radius is wide,
- has exactly one direct test, so coverage is thin,
- was last touched to handle declined cards, so that path is load-bearing.

That is enough to write the change carefully and add the right test, without a
scavenger hunt.

## Diff mode

If you want the blast radius of work already in progress:

```
seer_preflight { "fromRef": "main", "toRef": "HEAD" }
```

Seer maps the changed line ranges to the affected symbols and returns the same
kind of packet for each. See [Change history](change-history.md).

## From the CLI

```bash
seer preflight --symbol chargeCard
seer preflight --symbol chargeCard --file src/billing/payment.ts   # disambiguate
seer preflight --from main --to HEAD --json
```
