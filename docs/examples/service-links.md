# Service links

In a microservice repo (or a set of repos), the interesting bugs live in the
gaps between services. Seer resolves an outbound network call in one service to
the concrete route handler that serves it in another, so an agent can follow a
request across a boundary.

## What gets connected

Seer scans for client call signatures (fetch, axios, requests, httpx,
HttpClient, RestTemplate, gRPC, tRPC, GraphQL, and message-queue producers) and
records them in `service_calls`. After indexing, a resolver normalizes those URLs
and patterns and matches them against the `routes` it extracted from server
frameworks, producing `service_links`.

## The call

```
seer_service_links { "pathSubstr": "/invoices" }
```

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

The `shop` service calls `GET /api/invoices/<id>`; Seer resolves that to the
`billing` service's `/api/invoices/:id` handler, even though the client wrote the
URL with a template literal.

## Tracing a chain

To follow a request across several hops:

```
seer_trace_service_path { "from": "shop.getInvoice", "to": "billing.getInvoice" }
```

or fan out from one entry point:

```
seer_trace_service_dependencies { "from": "shop.checkout", "maxDepth": 3 }
```

## Crossing repos with external bundles

If the services live in separate repos, export a bundle from one and import it
additively into the other as a read-only layer:

```bash
# in the billing repo
seer bundle export --out billing.seerbundle

# in the shop repo
seer bundle import billing.seerbundle --external --alias billing
```

Now `shop`'s outbound calls resolve against `billing`'s real routes without
copying any source in. See [bundles in the CLI reference](../cli.md).

## From the CLI

```bash
seer service-calls --protocol http --path /invoices
seer service-links --match-kind exact
seer trace-service shop.getInvoice billing.getInvoice
```
