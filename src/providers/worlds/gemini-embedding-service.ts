import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { embedMany } from "ai"
import type { EmbeddingService } from "@worlds/client/search-index/embedding-service"
import { logger } from "../../utils/logger"

export type { EmbeddingService }

export const GEMINI_EMBEDDING_DIMENSIONS = 768
const MAX_BATCH_SIZE = 100

/**
 * GeminiEmbeddingService implements @worlds/client's EmbeddingService interface
 * using Google's gemini-embedding-2 via the Vercel AI SDK.
 *
 * Gemini's BatchEmbedContents API caps at 100 items per request, so we chunk
 * internally. Output is truncated to 768 dimensions (auto-normalized by the model).
 */
export class GeminiEmbeddingService implements EmbeddingService {
  private readonly model

  constructor(apiKey: string) {
    const google = createGoogleGenerativeAI({ apiKey })
    this.model = google.textEmbeddingModel("gemini-embedding-2")
  }

  async embed(texts: string[]): Promise<Array<Float32Array | number[]>> {
    if (texts.length === 0) return []

    const allVectors: Float32Array[] = []

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE)
      try {
        const { embeddings } = await embedMany({
          model: this.model,
          values: batch,
          providerOptions: {
            google: { outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS },
          },
        })
        allVectors.push(...embeddings.map((e) => new Float32Array(e)))
      } catch (err) {
        logger.error(`Gemini embed failed (batch ${Math.floor(i / MAX_BATCH_SIZE) + 1}, ${batch.length} texts): ${err}`)
        throw err
      }
    }

    logger.debug(
      `Gemini embed: ${texts.length} texts → ${allVectors.length} vectors (${allVectors[0]?.length ?? 0}d)`
    )

    return allVectors
  }
}
