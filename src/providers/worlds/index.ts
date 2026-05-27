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
import { TURTLE_PREFIXES, RDF, SCHEMA, PROV, XSD, WORLDS } from "./ontology"
import { validateGraph } from "./shapes"
import { GeminiEmbeddingService, GEMINI_EMBEDDING_DIMENSIONS } from "./gemini-embedding-service"
import { extractFactsToTurtle } from "./extraction"

let sharedQueryEngine: QueryEngine | undefined
function getSharedQueryEngine(): QueryEngine {
  if (!sharedQueryEngine) sharedQueryEngine = new QueryEngine()
  return sharedQueryEngine
}

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
    ingest: 2,
    indexing: 2,
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
    const queryEngine = getSharedQueryEngine()
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

      if (this.apiKey) {
        try {
          const cacheDir = join(this.baseDir, "claims-cache", sanitizePath(options.containerTag))
          const factsTurtle = await extractFactsToTurtle(this.apiKey, session, { cacheDir })
          if (factsTurtle) {
            await client.import({
              source: { kind: "serialized", data: factsTurtle, contentType: "text/turtle" },
            })
            logger.debug(`Imported extracted facts for session ${session.sessionId}`)
          }
        } catch (err) {
          logger.warn(`Fact extraction failed for ${session.sessionId}, continuing: ${err}`)
        }
      }

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

    const speakerA = metadata?.speakerA as string | undefined
    const speakerB = metadata?.speakerB as string | undefined

    // Session node: schema:Conversation + prov:Activity
    lines.push(
      `<${sessionUri}> <${RDF.type}> <${SCHEMA.Conversation}> .`,
      `<${sessionUri}> <${RDF.type}> <${PROV.Activity}> .`,
      `<${sessionUri}> <${SCHEMA.dateCreated}> "${date}" .`
    )
    if (speakerA) {
      lines.push(`<${sessionUri}> <${WORLDS.speakerA}> "${escapeTurtleLiteral(speakerA)}" .`)
    }
    if (speakerB) {
      lines.push(`<${sessionUri}> <${WORLDS.speakerB}> "${escapeTurtleLiteral(speakerB)}" .`)
    }

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
      if (msg.speaker) {
        lines.push(
          `<${msgUri}> <${SCHEMA.creator}> "${escapeTurtleLiteral(msg.speaker)}" .`
        )
      }
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

    const [searchResults, factClaimsRaw] = await Promise.all([
      searchWithFallback(client, query).then((r) => enrichSearchResults(client, r)),
      queryFactClaims(client, query),
    ])

    const first10 = searchResults.slice(0, 10)
    const rest = searchResults.slice(10)
    const searchCorpus = first10.map((r) => (r.text ?? "").toLowerCase()).join("\n")

    const factClaims = factClaimsRaw.filter((f) => {
      const c = f.claimText.toLowerCase().trim()
      if (c.length < 20) return true
      return !searchCorpus.includes(c.slice(0, Math.min(80, c.length)))
    })

    return [...first10, ...factClaims, ...rest]
  }

  async clear(containerTag: string): Promise<void> {
    this.clients.delete(containerTag)
    this.documentIds.delete(containerTag)
    const dbPath = join(this.baseDir, `${sanitizePath(containerTag)}.db`)
    await rm(dbPath, { force: true })
    const cachePath = join(this.baseDir, "claims-cache", sanitizePath(containerTag))
    await rm(cachePath, { recursive: true, force: true })
    logger.info(`Cleared Worlds provider state for ${containerTag}`)
  }
}

type SearchResponse = Awaited<ReturnType<Client["search"]>>
type SearchResult = NonNullable<SearchResponse["results"]>[number]

interface EnrichedSearchResult {
  sessionId: string
  text: string
  score: number
  subject: string
  predicate: string
  graph: string
  sessionDate?: string
  speaker?: string
  speakerA?: string
  speakerB?: string
}

/**
 * Resolves session dates, speaker names, and participant metadata for each
 * search result via a single batched SPARQL SELECT query.
 */
async function enrichSearchResults(
  client: Client,
  results: SearchResult[]
): Promise<EnrichedSearchResult[]> {
  const base: EnrichedSearchResult[] = results.map((r) => ({
    sessionId: r.id,
    text: r.text,
    score: r.score,
    subject: r.subject,
    predicate: r.predicate,
    graph: r.graph,
  }))

  if (base.length === 0) return base

  const msgUris = [...new Set(base.map((r) => r.subject))]
  const valuesClause = msgUris.map((uri) => `<${uri}>`).join(" ")

  const query = `
    SELECT ?msg ?date ?speaker ?speakerA ?speakerB WHERE {
      VALUES ?msg { ${valuesClause} }
      ?msg <${PROV.wasGeneratedBy}> ?session .
      ?session <${SCHEMA.dateCreated}> ?date .
      OPTIONAL { ?msg <${SCHEMA.creator}> ?speaker }
      OPTIONAL { ?session <${WORLDS.speakerA}> ?speakerA }
      OPTIONAL { ?session <${WORLDS.speakerB}> ?speakerB }
    }
  `

  try {
    const response = await client.sparql({ query })

    if (response.kind !== "select") return base

    const metaMap = new Map<
      string,
      { date?: string; speaker?: string; speakerA?: string; speakerB?: string }
    >()

    const str = (v?: { value: string | object }): string | undefined =>
      v && typeof v.value === "string" ? v.value : undefined

    for (const binding of response.data.results.bindings) {
      const msgUri = str(binding.msg)
      if (!msgUri) continue
      metaMap.set(msgUri, {
        date: str(binding.date),
        speaker: str(binding.speaker),
        speakerA: str(binding.speakerA),
        speakerB: str(binding.speakerB),
      })
    }

    for (const r of base) {
      const meta = metaMap.get(r.subject)
      if (meta) {
        r.sessionDate = meta.date
        r.speaker = meta.speaker
        r.speakerA = meta.speakerA
        r.speakerB = meta.speakerB
      }
    }

    logger.debug(`SPARQL enrichment: resolved metadata for ${metaMap.size}/${base.length} results`)
  } catch (err) {
    logger.warn(`SPARQL enrichment failed, returning unenriched results: ${err}`)
  }

  return base
}

interface FactClaimResult {
  isClaim: true
  claimText: string
  claimType: string
  subject: string
  action: string
  object: string
  when?: string
  where?: string
  sessionUri?: string
  sessionDate?: string
}

function escapeSparqlSubstring(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Proper nouns / capitalized tokens (e.g. person names) for structured matching. */
function extractQueryEntities(query: string): string[] {
  const noise = new Set([
    "what",
    "when",
    "where",
    "who",
    "why",
    "which",
    "how",
    "the",
    "and",
    "but",
    "this",
    "that",
    "these",
    "those",
    "did",
    "does",
    "with",
    "from",
    "your",
    "you",
    "she",
    "her",
    "his",
    "for",
    "are",
    "was",
    "were",
    "has",
    "have",
    "had",
    "not",
    "any",
    "all",
    "can",
    "may",
    "will",
    "would",
    "could",
    "should",
  ])
  const seen = new Set<string>()
  for (const m of query.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const w = m[0].toLowerCase()
    if (!noise.has(w)) seen.add(w)
  }
  return [...seen]
}

function buildTextMatchClause(terms: string[], joiner: "&&" | "||"): string {
  if (terms.length === 0) return "true"
  const op = ` ${joiner} `
  return terms.map((t) => `CONTAINS(LCASE(?claimText), "${escapeSparqlSubstring(t)}")`).join(op)
}

function buildEntityMatchClause(entities: string[]): string {
  if (entities.length === 0) return "true"
  return entities
    .map((e) => {
      const x = escapeSparqlSubstring(e)
      return (
        `CONTAINS(LCASE(?claimText), "${x}") || CONTAINS(LCASE(STR(?subj)), "${x}") || ` +
        `CONTAINS(LCASE(STR(?action)), "${x}") || CONTAINS(LCASE(STR(?obj)), "${x}")`
      )
    })
    .join(" || ")
}

function parseFactBindings(response: unknown): FactClaimResult[] {
  if (
    typeof response !== "object" ||
    response === null ||
    (response as { kind?: string }).kind !== "select"
  ) {
    return []
  }
  const data = (response as { data: { results: { bindings: Record<string, { value: string | object }>[] } } })
    .data
  if (!data?.results?.bindings) return []

  const str = (v?: { value: string | object }): string | undefined =>
    v && typeof v.value === "string" ? v.value : undefined

  const claims: FactClaimResult[] = []
  for (const binding of data.results.bindings) {
    const claimText = str(binding.claimText)
    if (!claimText) continue

    const typeUri = str(binding.type) || ""
    const claimType = typeUri.split("#").pop() || "Claim"

    claims.push({
      isClaim: true,
      claimText,
      claimType,
      subject: str(binding.subj) || "",
      action: str(binding.action) || "",
      object: str(binding.obj) || "",
      when: str(binding.when),
      where: str(binding.where),
      sessionUri: str(binding.session),
      sessionDate: str(binding.sessionDate),
    })
  }
  return claims
}

async function runFactClaimSparql(
  client: Client,
  textClause: string,
  entityClause: string,
  limit: number
): Promise<FactClaimResult[]> {
  const sparql = `
    SELECT ?claim ?claimText ?type ?subj ?action ?obj ?when ?where ?session ?sessionDate WHERE {
      ?claim <${RDF.type}> <${WORLDS.Claim}> .
      ?claim <${WORLDS.claimText}> ?claimText .
      ?claim <${RDF.type}> ?type .
      ?claim <${WORLDS.claimSubject}> ?subj .
      OPTIONAL { ?claim <${WORLDS.claimAction}> ?action }
      OPTIONAL { ?claim <${WORLDS.claimObject}> ?obj }
      OPTIONAL { ?claim <${WORLDS.claimWhen}> ?when }
      OPTIONAL { ?claim <${WORLDS.claimWhere}> ?where }
      OPTIONAL {
        ?claim <${PROV.wasDerivedFrom}> ?session .
        OPTIONAL { ?session <${SCHEMA.dateCreated}> ?sessionDate }
      }
      FILTER(?type != <${WORLDS.Claim}>)
      FILTER( ( ${entityClause} ) && ( ${textClause} ) )
    }
    LIMIT ${limit}
  `

  try {
    const response = await client.sparql({ query: sparql })
    return parseFactBindings(response)
  } catch (err) {
    logger.warn(`SPARQL fact claim query failed: ${err}`)
    return []
  }
}

/**
 * Queries extracted fact claims via SPARQL: entity-aware matching on
 * subject/action/object/claimText, AND-first on keywords for precision,
 * OR fallback for recall. LIMIT 8 for latency.
 */
async function queryFactClaims(
  client: Client,
  query: string
): Promise<FactClaimResult[]> {
  try {
    const terms = extractContentTerms(query)
    const entities = extractQueryEntities(query)
    if (terms.length === 0 && entities.length === 0) return []

    const entityClause = buildEntityMatchClause(entities)
    const limit = 8

    let claims: FactClaimResult[] = []

    if (terms.length > 0) {
      const textAnd = buildTextMatchClause(terms, "&&")
      claims = await runFactClaimSparql(client, textAnd, entityClause, limit)
      if (claims.length === 0 && terms.length > 1) {
        const textOr = buildTextMatchClause(terms, "||")
        claims = await runFactClaimSparql(client, textOr, entityClause, limit)
      }
    } else {
      claims = await runFactClaimSparql(client, "true", entityClause, limit)
    }

    if (claims.length > 0) {
      logger.debug(`SPARQL fact lookup: "${query.slice(0, 50)}…" → ${claims.length} claims`)
    }

    return claims
  } catch (err) {
    logger.warn(`SPARQL fact lookup failed: ${err}`)
    return []
  }
}

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
