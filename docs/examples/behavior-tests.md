# Behavior and tests

A flat "here are the test files that mention this symbol" list is noisy. Seer
ranks tests by how directly they exercise the symbol, so the agent reads the
specification that actually matters first.

## The call

```
seer_behavior { "symbol": "chargeCard" }
```

Trimmed response:

```json
{
  "symbol": "billing.PaymentService.chargeCard",
  "tests": [
    {
      "name": "charges a valid card",
      "file": "test/payment.spec.ts",
      "line": 24,
      "directness": "direct-call",
      "assertions": 4,
      "lastCommit": "2026-04-18"
    },
    {
      "name": "rejects an expired card",
      "file": "test/payment.spec.ts",
      "line": 51,
      "directness": "direct-call",
      "assertions": 3
    },
    {
      "name": "checkout completes end to end",
      "file": "test/checkout.e2e.ts",
      "line": 12,
      "directness": "graph-distance-2",
      "assertions": 7
    }
  ]
}
```

## How the ranking works

Tests are scored by, in order:

1. **Direct call** the test invokes the symbol itself.
2. **Naming convention** the test file mirrors the symbol's file.
3. **Graph distance** how many call-graph steps from the test to the symbol.
4. **Assertion count and recency** denser, more recently touched tests rank up.

So in the example, the two unit tests that call `chargeCard` directly sit above
the end-to-end test that only reaches it two hops away, even though the e2e test
has more assertions.

## Why an agent wants this

Before changing behavior, the agent can read the existing contract: an expired
card is rejected, a valid card charges. If the change should preserve that, the
agent knows which tests must stay green. If the change alters it, the agent knows
exactly which spec to update.

## From the CLI

```bash
seer behavior chargeCard
seer behavior chargeCard --depth 3 --limit 20
```
