import type { ProviderPrompts } from "../../types/prompts"

interface WorldsSearchResult {
  sessionId?: string
  text?: string
  score?: number
  subject?: string
  predicate?: string
  graph?: string
  sessionDate?: string
  speaker?: string
  speakerA?: string
  speakerB?: string
}

function buildWorldsContext(context: unknown[]): string {
  const results = context as WorldsSearchResult[]
  if (results.length === 0) return "(no results retrieved)"

  return results
    .map((r, i) => {
      const lines: string[] = []
      const score = r.score != null ? ` [relevance: ${r.score.toFixed(3)}]` : ""
      lines.push(`--- Result ${i + 1}${score} ---`)
      if (r.sessionDate) lines.push(`Session Date: ${r.sessionDate}`)
      if (r.speaker) lines.push(`Speaker: ${r.speaker}`)
      if (r.speakerA || r.speakerB) {
        const participants = [r.speakerA, r.speakerB].filter(Boolean).join(" & ")
        lines.push(`Participants: ${participants}`)
      }
      lines.push(`Text: ${r.text?.trim() || "(empty)"}`)
      return lines.join("\n")
    })
    .join("\n\n")
}

function buildWorldsAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildWorldsContext(context)

  return `You are a question-answering system with access to a conversational memory store. Answer the question using ONLY the retrieved context below.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Context:
${retrievedContext}

**How to Answer:**

1. **Temporal reasoning**: Each result has a "Session Date" indicating when the conversation took place. Use this to resolve relative time expressions:
   - "yesterday" in a session dated May 8, 2023 means May 7, 2023
   - "last week" means the week before the Session Date
   - When the Question Date is provided, use it as the reference point for interpreting the question itself
   - Always compute concrete dates from relative expressions before answering

2. **Speaker attribution**: Each result may have a "Speaker" field identifying who said it. The "Participants" field shows who was in the conversation:
   - Messages with role "user" come from the first participant (speakerA)
   - Messages with role "assistant" come from the second participant (speakerB)
   - Use speaker names to determine who said what, who did what, and who knows what

3. **Synthesis**: Combine information across multiple results when needed. Cross-reference dates, speakers, and content to build a complete answer.

4. **Be inferential**: If the answer can be reasonably inferred from the context (e.g., a date computed from a session date + relative expression, or a speaker identified from participant metadata), provide it rather than saying "I don't know".

5. **Only say "I don't know"** if the retrieved context genuinely contains no relevant information.

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
