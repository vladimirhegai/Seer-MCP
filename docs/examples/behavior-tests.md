# Behavior And Tests

`seer_behavior` ranks tests by how directly they exercise a symbol. That gives
an agent a practical reading list before it changes behavior.

## Call

```json
{ "symbol": "chargeCard" }
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
      "assertions": 4
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

## Ranking Signals

| Signal | Meaning |
|---|---|
| Direct call | The test invokes the symbol itself. |
| Naming match | The test file mirrors the target file. |
| Graph distance | The test reaches the symbol through callers. |
| Assertion density | Denser specs rank higher. |
| Recency | Recently touched tests get a small lift. |

## Why It Helps

The agent can read the direct unit tests first, then the end-to-end test if the
change touches the wider checkout flow.

## CLI

```bash
seer behavior chargeCard
seer behavior chargeCard --depth 3 --limit 20
```
