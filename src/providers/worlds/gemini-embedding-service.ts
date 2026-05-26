import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { embedMany } from "ai"
import type { EmbeddingService } from "@worlds/client/search-index/embedding-service"
import { logger } from "../../utils/logger"

export type { EmbeddingService }

export const GEMINI_EMBEDDING_DIMENSIONS = 768

/**
 * GeminiEmbeddingService implements @worlds/client's EmbeddingService interface
 * using Google's text-embedding-004 via the Vercel AI SDK.
 *
 * The AI SDK auto-batches via the :batchEmbedContents endpoint when multiple
 * values are provided.
 */
export class GeminiEmbeddingService implements EmbeddingService {
  private readonly model

  constructor(apiKey: string) {
    const google = createGoogleGenerativeAI({ apiKey })
    this.model = google.textEmbeddingModel("text-embedding-004")
  }

  async embed(texts: string[]): Promise<Array<Float32Array | number[]>> {
    if (texts.length === 0) return []

    const { embeddings } = await embedMany({
      model: this.model,
      values: texts,
    })

    logger.debug(
      `Gemini embed: ${texts.length} texts → ${embeddings.length} vectors (${embeddings[0]?.length ?? 0}d)`
    )

    return embeddings.map((e) => new Float32Array(e))
  }
}
