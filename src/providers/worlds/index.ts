import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { Client } from "@worlds/client"
import { ComunicaSparqlEngine } from "@worlds/client/adapters/comunica"
import { createLibsqlClientOptions } from "@worlds/client/adapters/libsql"
import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { WORLDS_PROMPTS } from "./prompts"
import { TURTLE_PREFIXES, RDF, SCHEMA, PROV, XSD } from "./ontology"
import { validateGraph } from "./shapes"
import { GeminiEmbeddingService, GEMINI_EMBEDDING_DIMENSIONS } from "./gemini-embedding-service"

/**
 * WorldsProvider implements the Provider interface for @worlds/client.
 *
 * @worlds/client is a graph-backed memory store with RDF import, semantic
 * search, and SPARQL query capabilities. This provider uses file-backed
 * LibSQL databases so completed ingest/index phases can be reused when a run
 * is resumed.
 */
export class WorldsProvider implements Provider {
  name = "worlds"
  prompts = WORLDS_PROMPTS
  concurrency = {
    default: 10,
    ingest: 10,
    indexing: 10,
  }

  private clients = new Map<string, Client>()
  private documentIds = new Map<string, string[]>()
  private baseDir = join(process.cwd(), "data", "providers", "worlds")
  private apiKey = ""

  async initialize(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey
    await mkdir(this.baseDir, { recursive: true })
    this.clients.clear()
    this.documentIds.clear()
    logger.info(`Initialized Worlds provider with file-backed LibSQL at ${this.baseDir}`)
  }

  private async getClient(containerTag: string): Promise<Client> {
    const existing = this.clients.get(containerTag)
    if (existing) return existing

    await mkdir(this.baseDir, { recursive: true })
    const dbPath = join(this.baseDir, `${sanitizePath(containerTag)}.db`)
    const libsqlClient = createClient({ url: `file:${dbPath}` })
    const queryEngine = new QueryEngine()
    const embeddingService = this.apiKey ? new GeminiEmbeddingService(this.apiKey) : undefined
    const client = new Client(
      await createLibsqlClientOptions({
        client: libsqlClient,
        embeddingService,
        vectorDimensions: embeddingService ? GEMINI_EMBEDDING_DIMENSIONS : undefined,
        searchIndexOnImport: false,
        createSparqlEngine: ({ libsqlStore }) =>
          new ComunicaSparqlEngine({ queryEngine, store: libsqlStore }),
      })
    )
    this.clients.set(containerTag, client)
    return client
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const client = await this.getClient(options.containerTag)
    const ids = this.documentIds.get(options.containerTag) ?? []

    for (const session of sessions) {
      const turtle = this.formatSessionForIngestion(session)

      await client.import({
        source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
      })

      ids.push(session.sessionId)
      logger.debug(`Ingested session ${session.sessionId} with ${session.messages.length} messages`)
    }

    this.documentIds.set(options.containerTag, ids)
    return { documentIds: sessions.map((session) => session.sessionId) }
  }

  private formatSessionForIngestion(session: UnifiedSession): string {
    const { sessionId, messages, metadata } = session
    const sessionUri = `urn:session:${sessionId}`

    const date = (metadata?.formattedDate as string) || (metadata?.date as string) || "unknown"

    const lines: string[] = [TURTLE_PREFIXES, ""]

    // Session node: schema:Conversation + prov:Activity
    lines.push(
      `<${sessionUri}> <${RDF.type}> <${SCHEMA.Conversation}> .`,
      `<${sessionUri}> <${RDF.type}> <${PROV.Activity}> .`,
      `<${sessionUri}> <${SCHEMA.dateCreated}> "${date}" .`
    )

    // Message nodes with typed predicates and provenance
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx]
      const msgUri = `${sessionUri}/msg/${idx}`
      const escapedContent = escapeTurtleLiteral(msg.content as string)

      lines.push(
        "",
        `<${sessionUri}> <${SCHEMA.hasPart}> <${msgUri}> .`,
        `<${msgUri}> <${RDF.type}> <${SCHEMA.Message}> .`,
        `<${msgUri}> <${RDF.type}> <${PROV.Entity}> .`,
        `<${msgUri}> <${SCHEMA.text}> "${escapedContent}" .`,
        `<${msgUri}> <${SCHEMA.position}> "${idx}"^^<${XSD.integer}> .`,
        `<${msgUri}> <${SCHEMA.author}> "${msg.role}" .`,
        `<${msgUri}> <${PROV.wasGeneratedBy}> <${sessionUri}> .`
      )
    }

    const turtle = lines.join("\n")

    const validation = validateGraph(turtle)
    if (!validation.valid) {
      logger.warn(
        `SHACL validation warnings for session ${sessionId}: ${validation.errors.join("; ")}`
      )
    }

    return turtle
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const client = await this.getClient(containerTag)
    const indexResult = await client.rebuildSearchIndex()
    logger.info(
      `Worlds: rebuilt search index for ${containerTag} — ` +
        `${indexResult.processedQuadCount} quads processed, ${indexResult.chunkRowCount} chunk rows`
    )
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const client = await this.getClient(options.containerTag)

    const results = await searchWithFallback(client, query)

    return results.map((r) => ({
      sessionId: r.id,
      text: r.text,
      score: r.score,
      subject: r.subject,
      predicate: r.predicate,
      graph: r.graph,
    }))
  }

  async clear(containerTag: string): Promise<void> {
    this.clients.delete(containerTag)
    this.documentIds.delete(containerTag)
    const dbPath = join(this.baseDir, `${sanitizePath(containerTag)}.db`)
    await rm(dbPath, { force: true })
    logger.info(`Cleared Worlds provider state for ${containerTag}`)
  }
}

type SearchResponse = Awaited<ReturnType<Client["search"]>>
type SearchResult = NonNullable<SearchResponse["results"]>[number]

async function runSearch(client: Client, query: string): Promise<SearchResult[]> {
  const response = await client.search({ query })
  return response.results ?? []
}

/**
 * Try the full query first. FTS5 uses AND between terms after stopword
 * removal, so long natural-language questions often match nothing.
 * Fall back to per-term OR-style search and merge via best-score dedup.
 * With embeddings active the primary hybrid search handles most queries
 * directly, but the fallback still catches degraded keyword-only mode.
 */
async function searchWithFallback(client: Client, query: string): Promise<SearchResult[]> {
  const results = await runSearch(client, query)
  if (results.length > 0) {
    logger.debug(`Worlds search: "${query.slice(0, 50)}…" → ${results.length} results`)
    return results
  }

  const terms = extractContentTerms(query)
  if (terms.length <= 1) return results

  const seen = new Map<string, SearchResult>()
  for (const term of terms) {
    for (const r of await runSearch(client, term)) {
      const existing = seen.get(r.id)
      if (!existing || r.score > existing.score) {
        seen.set(r.id, r)
      }
    }
  }

  const merged = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 100)
  logger.info(
    `Worlds search broadened: "${query.slice(0, 50)}…" → ${terms.length} terms → ${merged.length} results`
  )
  return merged
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "please",
  "that",
  "the",
  "their",
  "these",
  "those",
  "this",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
])

function extractContentTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

function escapeTurtleLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

export default WorldsProvider
