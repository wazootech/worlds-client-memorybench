# Worlds Provider (`-p worlds`)

Adapter for `@worlds/client` (graph-backed memory / RAG provider) in MemoryBench.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | **Yes** | Gemini text-embedding-004 for search vectors + judge/answer LLM |
| `OPENAI_API_KEY` | For judge/answer | Used by the judge LLM when evaluating answers |
| `ANTHROPIC_API_KEY` | Alt judge | Alternative judge backend |

`GOOGLE_GENERATIVE_AI_API_KEY` is used both for the embedding service (search index)
and as the judge/answer LLM backend when using Gemini models. The provider uses
file-backed LibSQL databases under `data/providers/worlds/` so resumed runs can
reuse already-ingested graph data.

## Phase mapping

| Pipeline phase | Worlds mapping |
|:----------------|:---------------|
| **Ingest** | Session messages → RDF Turtle → `client.import()` |
| **Index** | `client.rebuildSearchIndex()` — builds FTS5 + 768-dim vector chunks from durable quads |
| **Search** | `client.search({ query })` — hybrid keyword + vector search (RRF fusion) with per-term fallback |
| **Answer** | MemoryBench judge layer (unchanged) — configurable LLM via `-j` |
| **Evaluate** | MemoryBench judge (unchanged) — MemScore reporting |

## Running LoCoMo smoke test

```bash
bun install
cp .env.example .env.local   # add API keys

# 1. Ingest + index once (builds LibSQL DBs + embedding vectors)
bun run src/index.ts run -p worlds -b locomo -l 5 -r smoke-001 -j gemini-2.5-flash -m gemini-2.5-flash

# 2. Iterate on search/answer/evaluate — reuses ingested data, zero re-embedding cost
bun run src/index.ts run -r smoke-001 -f search -j gemini-2.5-flash -m gemini-2.5-flash
```

Use `-f search` to skip ingest and indexing on subsequent runs. The file-backed
LibSQL databases persist under `data/providers/worlds/`, so only the LLM
answer + judge calls are repeated. Change `-j` or `-m` between iterations to
compare different models against the same indexed data.

## Design notes

- **File-backed storage**: each MemoryBench `containerTag` gets its own LibSQL file under `data/providers/worlds/`, avoiding cross-question state leaks while preserving data for resumed runs.
- **Hybrid search**: When `GOOGLE_GENERATIVE_AI_API_KEY` is set, the search index uses Gemini text-embedding-004 (768-dim vectors) alongside FTS5 keyword search, fused via Reciprocal Rank Fusion (RRF). Without the key, search falls back to keyword-only mode.
- **Per-term fallback**: FTS5 uses implicit AND between terms, so long natural-language queries often match nothing. The provider extracts content terms (filtering stopwords) and retries individual terms, merging results by best score.
- **Index rebuild**: `rebuildSearchIndex()` is called after ingest so newly imported triples are discoverable via `search()`. Import uses `deferSearchIndexOnImport` to skip per-commit indexing during bulk loads.
- **Search results**: Worlds returns `(id, subject, predicate, graph, text, score)` — mapped to MemoryBench's generic `SearchResult` shape.
- **SPARQL**: This provider stub uses the basic keyword search path. Future iterations may wire `client.sparql()` for structured follow-up queries (see `executeSparql` in `worlds-client-evals`).
