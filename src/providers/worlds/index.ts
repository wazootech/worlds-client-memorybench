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
      const sessionId = session.sessionId

      // Build Turtle RDF from the session's messages.
      // Each message becomes rdf:Statement quads in the graph.
      const triples = session.messages.map((msg, idx) => {
        const msgUri = `urn:session:${sessionId}/msg/${idx}`
        const escapedContent = (msg.content as string)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n")
        return [
          `<${msgUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .`,
          `<${msgUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate> <http://schema.org/text> .`,
          `<${msgUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#object> "${escapedContent}" .`,
          `<${msgUri}> <http://schema.org/role> "${msg.role}" .`,
        ].join("\n")
      })

      const date =
        (session.metadata?.formattedDate as string) ||
        (session.metadata?.date as string) ||
        "unknown"
      const metadataTriples = [
        `<urn:session:${sessionId}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Conversation> .`,
        `<urn:session:${sessionId}> <http://schema.org/date> "${date}" .`,
      ]

      const turtle = [
        "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
        "@prefix schema: <http://schema.org/> .",
        ...triples,
        ...metadataTriples,
      ].join("\n")

      await client.import({
        source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
      })

      ids.push(sessionId)
      logger.debug(`Ingested session ${sessionId} with ${session.messages.length} messages`)
    }

    this.documentIds.set(options.containerTag, ids)
    return { documentIds: sessions.map((session) => session.sessionId) }
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

export default WorldsProvider
