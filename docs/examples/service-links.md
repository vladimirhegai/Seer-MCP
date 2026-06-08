# Service Links

Seer can connect an outbound call in one service to the handler that serves it
in another service. This is useful when a bug crosses a network boundary.

## What Gets Connected

| Source | Examples |
|---|---|
| HTTP clients | `fetch`, `axios`, `requests`, `httpx`, `HttpClient`, `RestTemplate` |
| RPC | gRPC, tRPC |
| GraphQL | queries and resolver names |
| Queues | Kafka, SQS-style producers and consumers |
| Routes | Express, Fastify, FastAPI, Flask, Spring, GraphQL, tRPC, `.proto` |

## Call

```json
{ "pathSubstr": "/invoices" }
```

Call `seer_service_links`.

Trimmed response:

```json
{
  "links": [
    {
      "protocol": "http",
      "method": "GET",
      "path": "/api/invoices/:id",
      "matchKind": "param",
      "client": {
        "symbol": "shop.getInvoice",
        "file": "services/shop/src/billing.ts",
        "line": 40
      },
      "handler": {
        "symbol": "billing.getInvoice",
        "file": "services/billing/src/routes.ts",
        "line": 77
      },
      "confidence": 0.95
    }
  ]
}
```

## Trace A Chain

```json
{
  "from": "shop.getInvoice",
  "to": "billing.getInvoice"
}
```

Call `seer_trace_service_path`.

For fan-out:

```json
{
  "from": "shop.checkout",
  "maxDepth": 3
}
```

Call `seer_trace_service_dependencies`.

## Across Repos

Export one repo as a bundle:

```bash
seer bundle export --out billing.seerbundle
```

Import it as a read-only layer:

```bash
seer bundle import billing.seerbundle --external --alias billing
```

Now the current repo can resolve calls against the imported service routes.

## CLI

```bash
seer service-calls --protocol http --path /invoices
seer service-links --match-kind exact
seer trace-service shop.getInvoice billing.getInvoice
```
