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
 * search, and SPARQL query capabilities. This provider uses an in-memory
 * LibSQL database, matching the approach in worlds-client-evals for
 * deterministic, self-contained eval runs.
 */
export class WorldsProvider implements Provider {
  name = "worlds"
  prompts = WORLDS_PROMPTS
  concurrency = {
    default: 10,
    ingest: 10,
    indexing: 10,
  }

  private client: Client | null = null
  private documentIds: string[] = []

  async initialize(config: ProviderConfig): Promise<void> {
    const libsqlClient = createClient({ url: "file::memory:" })
    const queryEngine = new QueryEngine()
    this.client = new Client(
      await createLibsqlClientOptions({
        client: libsqlClient,
        createSparqlEngine: ({ libsqlStore }) =>
          new ComunicaSparqlEngine({ queryEngine, store: libsqlStore }),
      })
    )
    this.documentIds = []
    logger.info(`Initialized Worlds provider with in-memory LibSQL`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.client) throw new Error("Provider not initialized")

    this.documentIds = []

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

      await this.client.import({
        source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
      })

      this.documentIds.push(sessionId)
      logger.debug(`Ingested session ${sessionId} with ${session.messages.length} messages`)
    }

    return { documentIds: this.documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")
    // Rebuild the derived FTS/vector search index so that newly ingested
    // triples are discoverable via client.search().
    await this.client.rebuildSearchIndex()
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
    logger.info(`Worlds: indexing complete for container ${containerTag}`)
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.client) throw new Error("Provider not initialized")

    const response = await this.client.search({ query })

    return (response.results ?? []).map((r) => ({
      sessionId: r.id,
      text: r.text,
      score: r.score,
      subject: r.subject,
      predicate: r.predicate,
      graph: r.graph,
    }))
  }

  async clear(_containerTag: string): Promise<void> {
    this.client = null
    this.documentIds = []
    logger.info("Cleared Worlds in-memory provider state")
  }
}

export default WorldsProvider
