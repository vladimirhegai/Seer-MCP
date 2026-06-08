# Examples

These examples show the shape of real Seer workflows. Outputs are trimmed so the
idea is easy to see.

## Quick Map

| Goal | Call | Walkthrough |
|---|---|---|
| Check a symbol before editing | `seer_preflight` | [Pre-edit context](examples/pre-edit-context.md) |
| Find the tests that matter | `seer_behavior` | [Behavior and tests](examples/behavior-tests.md) |
| Follow service boundaries | `seer_service_links` | [Service links](examples/service-links.md) |
| Inspect a diff | `seer_preflight` with refs | [Change history](examples/change-history.md) |
| Read a long file cheaply | `seer_skeleton` | This page |
| Sample real call sites | `seer_callers` with snippets | This page |

## Before Editing Unfamiliar Code

```json
{ "symbol": "chargeCard" }
```

Call `seer_preflight`. The response includes definition, callers, tests, recent
history, route exposure, and risk.

## Find Tests For A Symbol

```json
{ "symbol": "chargeCard" }
```

Call `seer_behavior`. Tests are ranked by how directly they exercise the symbol.

## Follow Service Boundaries

```json
{ "pathSubstr": "/invoices" }
```

Call `seer_service_links`. Seer connects outbound calls to route handlers when
both sides are in the index or in imported bundles.

## Inspect A Diff

```json
{ "fromRef": "main", "toRef": "HEAD" }
```

Call `seer_preflight`. Seer maps changed lines to changed symbols, then adds
impact and risk context.

## Read A Long File Cheaply

```json
{
  "file": "src/server.ts",
  "focusSymbol": "startServer"
}
```

Call `seer_skeleton`. The file comes back as an outline, with one focused body
expanded when requested.

## Sample Real Argument Patterns

```json
{
  "symbol": "buildInvoice",
  "limit": 5,
  "includeSnippets": true,
  "snippetContext": 2
}
```

Call `seer_callers`. The result includes real source around each call site, which
is useful before writing another call.

## Find Historical Coupling

```json
{ "symbol": "serializeMessage" }
```

Call `seer_changes_with`. Partners include `sharedCommits` and `confidence`.
Check `historyComplete` before trusting an empty result.

## Batch Related Lookups

```json
{
  "calls": [
    { "tool": "seer_definition", "args": { "name": "chargeCard" } },
    { "tool": "seer_callers", "args": { "symbol": "chargeCard" } },
    { "tool": "seer_behavior", "args": { "symbol": "chargeCard" } }
  ]
}
```

Call `seer_batch` when an agent needs several small facts together.
