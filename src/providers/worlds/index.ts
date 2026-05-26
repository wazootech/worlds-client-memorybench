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

  async initialize(config: ProviderConfig): Promise<void> {
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
    const client = new Client(
      await createLibsqlClientOptions({
        client: libsqlClient,
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

    const date =
      (metadata?.formattedDate as string) ||
      (metadata?.date as string) ||
      "unknown"

    const lines: string[] = [TURTLE_PREFIXES, ""]

    // Session node: schema:Conversation + prov:Activity
    lines.push(
      `<${sessionUri}> <${RDF.type}> <${SCHEMA.Conversation}> .`,
      `<${sessionUri}> <${RDF.type}> <${PROV.Activity}> .`,
      `<${sessionUri}> <${SCHEMA.dateCreated}> "${date}" .`,
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
        `<${msgUri}> <${PROV.wasGeneratedBy}> <${sessionUri}> .`,
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
    // Rebuild the derived FTS/vector search index so that newly ingested
    // triples are discoverable via client.search().
    await client.rebuildSearchIndex()
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
    logger.info(`Worlds: indexing complete for container ${containerTag}`)
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const client = await this.getClient(options.containerTag)

    const response = await client.search({ query })

    return (response.results ?? []).map((r) => ({
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
