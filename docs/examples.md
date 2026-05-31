# Examples

Real workflows, the way an agent (or you, from the CLI) would actually use Seer.
Each one links to a fuller walkthrough.

The outputs below are illustrative and trimmed for readability. Shapes are real;
exact numbers depend on your repo.

---

## Before editing unfamiliar code

You are about to change `chargeCard`. Instead of five searches, one call:

```
seer_preflight { "symbol": "chargeCard" }
```

You get the definition, who calls it, the tests that cover it, recent commits,
and a risk verdict in a single packet. Full walkthrough:
[Pre-edit context](examples/pre-edit-context.md).

---

## Find the tests that actually exercise a symbol

```
seer_behavior { "symbol": "chargeCard" }
```

Ranked by how directly each test hits the symbol, not just filename matching.
Full walkthrough: [Behavior and tests](examples/behavior-tests.md).

---

## Follow routes across service boundaries

```
seer_service_links { "pathSubstr": "/invoices" }
```

See which client call in one service resolves to which route handler in another.
Full walkthrough: [Service links](examples/service-links.md).

---

## Understand recent changes

```
seer_preflight { "fromRef": "main", "toRef": "HEAD" }
```

Maps the diff to the affected symbols and their blast radius, then layers on the
history for each. Full walkthrough: [Change history](examples/change-history.md).

---

## Read a giant file cheaply

```
seer_skeleton { "file": "src/server.ts" }
```

Returns every signature with bodies collapsed to `{ ... 40 lines ... }`. Add
`focusSymbol` to expand exactly one body. A 2,000-line file becomes an outline
you can scan for a few hundred tokens.

---

## Batch several lookups into one round-trip

```
seer_batch { "calls": [
  { "tool": "seer_definition", "args": { "name": "chargeCard" } },
  { "tool": "seer_callers",    "args": { "symbol": "chargeCard" } },
  { "tool": "seer_behavior",   "args": { "symbol": "chargeCard" } }
] }
```

One request, three results, failure-isolated.
