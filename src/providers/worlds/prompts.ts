import type { ProviderPrompts } from "../../types/prompts"

interface WorldsSearchResult {
  sessionId?: string
  text?: string
  score?: number
  subject?: string
  predicate?: string
  graph?: string
}

function buildWorldsContext(context: unknown[]): string {
  const results = context as WorldsSearchResult[]
  if (results.length === 0) return "(no results retrieved)"

  return results
    .map((r, i) => {
      const text = r.text?.trim() || "(empty)"
      const score = r.score != null ? ` [relevance: ${r.score.toFixed(3)}]` : ""
      return `--- Result ${i + 1}${score} ---\n${text}`
    })
    .join("\n\n")
}

function buildWorldsAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildWorldsContext(context)

  return `You are a question-answering system. Based on the retrieved context below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Context:
${retrievedContext}

**How to Answer:**
1. Read each retrieved result carefully — they are text fragments from a graph-backed conversational memory store.
2. Use temporal context: "Question Date" is the reference point for relative time expressions like "yesterday", "last week", "recently". Calculate relative dates from the Question Date, NOT the current date.
3. Synthesize information from multiple results if needed.
4. If the context does not contain enough information, respond with "I don't know".
5. Base your answer ONLY on the provided context — do not use outside knowledge.

**Response Format:**
Think step by step, then provide your answer.

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const WORLDS_PROMPTS: ProviderPrompts = {
  answerPrompt: buildWorldsAnswerPrompt,
}
