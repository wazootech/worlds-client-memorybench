import type { ProviderPrompts } from "../../types/prompts"

/**
 * WORLDS_PROMPTS provides the prompt configuration for the Worlds provider.
 *
 * @worlds/client uses a graph-based semantic search pipeline:
 *   search(query) → sparql(binding) → answer
 *
 * The provider prompt guides how retrieved context is interpreted.
 */
export const WORLDS_PROMPTS: ProviderPrompts = {
  answerPrompt: (question, context) => {
    const ctx = JSON.stringify(context, null, 2)
    return `You are an AI assistant answering questions based on retrieved
conversational memory from a graph-backed system. Use the provided context
to answer the question accurately.

If the context does not contain enough information to answer the question,
say that you don't know rather than guessing.

Context:
${ctx}

Question: ${question}

Answer:`
  },
}
