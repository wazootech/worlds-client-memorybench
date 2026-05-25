# Worlds Provider (`-p worlds`)

Adapter for `@worlds/client` (graph-backed memory / RAG provider) in MemoryBench.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | For judge/answer | Used by the judge LLM when evaluating answers |
| `ANTHROPIC_API_KEY` | Alt judge | Alternative judge backend |
| `GOOGLE_API_KEY` | Alt judge | Alternative judge backend |

No Worlds-specific API keys are needed — the provider uses an in-memory LibSQL database
for self-contained eval runs, matching the approach in `worlds-client-evals`.

## Phase mapping

| Pipeline phase | Worlds mapping |
|:----------------|:---------------|
| **Ingest** | Session messages → RDF Turtle → `client.import()` |
| **Index** | `client.rebuildSearchIndex()` — builds FTS/vector chunks from durable quads |
| **Search** | `client.search({ query })` — hybrid keyword/vector search over literals |
| **Answer** | MemoryBench judge layer (unchanged) — configurable LLM via `-j` |
| **Evaluate** | MemoryBench judge (unchanged) — MemScore reporting |

## Running LoCoMo smoke test

```bash
bun install
cp .env.example .env.local   # add API keys
bun run src/index.ts run -p worlds -b locomo -l 5 -j gpt-4o -m gemini-3.1-flash-lite
```

## Design notes

- **In-memory only**: each run starts fresh with `file::memory:` — no persistent state between runs.
- **Index rebuild**: `rebuildSearchIndex()` is called after ingest so newly imported triples are discoverable via `search()`.
- **Search results**: Worlds returns `(id, subject, predicate, graph, text, score)` — mapped to MemoryBench's generic `SearchResult` shape.
- **SPARQL**: This provider stub uses the basic keyword search path. Future iterations may wire `client.sparql()` for structured follow-up queries (see `executeSparql` in `worlds-client-evals`).