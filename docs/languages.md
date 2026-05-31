# Language Support

Seer parses with Tree-sitter, so adding depth to a language is mostly about
writing a good extractor, not wrestling a parser. Nine languages ship today.

## Supported languages

| Language | Symbols + calls | Imports | Routes | Service calls | Config reads |
|---|:---:|:---:|:---:|:---:|:---:|
| Python | yes | yes | FastAPI, Flask | requests, httpx | `os.getenv` |
| JavaScript | yes | yes | Express, Fastify | fetch, axios | `process.env` |
| TypeScript / TSX | yes | yes | Express, Fastify, tRPC, GraphQL | fetch, axios | `process.env` |
| Go | yes | yes | (via gRPC `.proto`) | gRPC, net/http clients | `os.Getenv` |
| Java | yes | yes | Spring Boot | gRPC, RestTemplate, HttpClient | `System.getenv` |
| Rust | yes | yes | no | reqwest-style clients | env reads |
| C | yes | yes | no | no | no |
| C++ | yes | yes | no | no | no |
| C# | yes | yes | no | gRPC, HttpClient | env reads |

"Routes" means server-side endpoint extraction. gRPC routes come from `.proto`
files regardless of the implementing language. A language without HTTP route
extraction can still be a *client* in a service link; it just cannot be the HTTP
*target*. See [Known Limits](limits.md) for the precise boundary.

Every language gets the structural core: definitions with qualified names, call
edges, imports, complexity metrics, and shape hashes. The columns above are the
extras layered on top.

## Notable per-language handling

- **C / C++** use syntactic body gating: a `struct device *dev` reference does
  not create a phantom `device` symbol. Out-of-line method definitions
  (`T Vec<T>::dot(...)`) reconstruct the owning class scope, so they qualify as
  `Vec.dot`, not a free function.
- **TypeScript** maps the TSX grammar for React components and preserves path
  parameters in template-literal URLs so cross-service links resolve.
- **Java** Spring controllers inherit class-level path prefixes.
- **C#** tracks constructor and member calls.

## Adding a language (for contributors)

Adding a language is mostly about writing a good extractor; Tree-sitter does the
parsing. The shape of the work:

1. **Register the grammar.** Map the file extensions and load the Tree-sitter
   WASM grammar in the parser context.
2. **Write the extractor** in `src/parser/languages/<lang>.ts`. It walks the AST
   and returns definitions (with short names), the names a node calls or
   references, and imports. Declare its `candidateNodeTypes` so the walker only
   runs your callbacks on the node types you care about, which keeps big repos
   fast.
3. **Get qualified names right.** Return short names and, when a definition has
   an owning scope (a class, a namespace, an out-of-line method), set the
   `scopePath` hint and let the walker fold it into the qualified name. Do not
   hand-build qualified names in the extractor.
4. **Layer on the optional signals** if the language has them: routes, config or
   env reads, and outbound service calls.
5. **Add a smoke fixture** under `tests/fixtures/` and assertions in
   `tests/smoke.ts`, so the new language is covered and stays covered.

The best starting point is an existing extractor close to your target:
`go.ts` for a C-family procedural language, `typescript.ts` for something with
rich imports and routes, `cpp.ts` for the gnarly cases (out-of-line methods,
body gating). The core pieces to read first are `src/types.ts`,
`src/parser/walker.ts`, and `src/parser/parserContext.ts`.

The watch-outs that tend to bite: emit type references and forward declarations
with the right `symbol_role` so they do not pollute search or PageRank; keep the
extractor pure and deterministic; and make sure cached re-indexing produces the
exact same rows (the scale and parity tests will catch you if it does not).
