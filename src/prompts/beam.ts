export interface BeamRubricJudgeResult {
  score: number
  reason: string
}

/**
 * Number of memories to retrieve per BEAM search. Matches mem0's evaluation
 * cutoff exactly (their --top-k-cutoffs default) so the answering model sees
 * the same context budget. mem0 retrieves 200 and trims to 100; we retrieve
 * 100 directly since we evaluate at a single cutoff.
 */
export const BEAM_SEARCH_TOP_K = 100

/**
 * How many of the retrieved memories to expose to the answering model.
 * Mirrors BEAM_SEARCH_TOP_K — every retrieved memory is shown.
 */
export const BEAM_ANSWER_TOP_K = 100

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const MONTH_TO_NUMBER: Record<string, string> = Object.fromEntries(
  MONTH_NAMES.map((name, i) => [name.toLowerCase(), String(i + 1).padStart(2, "0")])
)

/**
 * Parse BEAM's per-batch time_anchor strings into ISO YYYY-MM-DD. BEAM stores
 * these as "Month-DD-YYYY" (e.g. "March-01-2024"); some batches have a null
 * anchor, in which case we return undefined and the memory line is rendered
 * without a date prefix (matching mem0's "if no created_at" branch).
 */
export function parseBeamTimeAnchor(anchor: unknown): string | undefined {
  if (typeof anchor !== "string") return undefined
  const m = anchor.match(/^(\w+)-(\d{1,2})-(\d{4})$/)
  if (!m) return undefined
  const [, monthName, dayStr, year] = m
  const month = MONTH_TO_NUMBER[monthName.toLowerCase()]
  if (!month) return undefined
  return `${year}-${month}-${dayStr.padStart(2, "0")}`
}

/**
 * Human-readable form of a BEAM ISO date, used as `formattedDate` on session
 * metadata so the Supermemory provider includes a natural-language date prefix
 * in the ingested content (mirrors the LocoMo / LongMemEval pattern).
 */
export function formatBeamDate(iso: string): string {
  const [year, month, day] = iso.split("-")
  const monthName = MONTH_NAMES[parseInt(month, 10) - 1]
  if (!monthName) return iso
  return `${monthName} ${parseInt(day, 10)}, ${year}`
}

interface BeamMemoryLike {
  memory?: string
  content?: string
  metadata?: { sessionId?: string }
}

/**
 * Ported verbatim from mem0's get_beam_answer_generation_prompt
 * (mem0ai/memory-benchmarks/benchmarks/beam/prompts.py). Memories are sliced
 * to BEAM_ANSWER_TOP_K, sorted chronologically (oldest first), numbered, and
 * prefixed with their session date when available — exactly the format mem0's
 * answering LLM sees on their published BEAM 1M / 10M numbers.
 */
export function buildBeamAnswerPrompt(
  question: string,
  memories: unknown[],
  sessionDateMap: Map<string, string>
): string {
  const sliced = memories.slice(0, BEAM_ANSWER_TOP_K) as BeamMemoryLike[]
  const memoriesText = formatBeamMemories(sliced, sessionDateMap)
  return `You are an AI assistant with access to stored memories from prior conversations with a user.
Use these memories to answer the following question as accurately and completely as possible.

IMPORTANT RULES:
1. Scan ALL provided memories before answering — do not stop after the first relevant one.
2. If multiple memories contain relevant information, combine and cross-reference them.
3. If the memories contain contradictory information, prefer the more recent one.
4. If the memories don't contain enough information to answer, say exactly: "I don't have enough information to answer this question."
5. For temporal questions: pay attention to dates and relative time references.
6. For ordering questions: present events in chronological order.
7. For preference questions: use the most recently stated preference.
8. Be specific and direct — include exact names, dates, numbers, and details from the memories.
9. Do NOT invent or assume information that isn't in the memories.

QUESTION: ${question}

RETRIEVED MEMORIES:
${memoriesText}

ANSWER:`
}

function formatBeamMemories(
  memories: BeamMemoryLike[],
  sessionDateMap: Map<string, string>
): string {
  if (memories.length === 0) return "(No memories available)"

  // Resolve text + date per memory.
  const items = memories.map((m) => {
    const text =
      typeof m?.memory === "string"
        ? m.memory
        : typeof m?.content === "string"
          ? m.content
          : JSON.stringify(m)
    const sessionId =
      typeof m?.metadata?.sessionId === "string" ? m.metadata.sessionId : ""
    const date = sessionId ? sessionDateMap.get(sessionId) : undefined
    return { text, sessionId, date }
  })

  // mem0 sorts by created_at ascending (oldest first). When date is missing
  // we fall back to sessionId order, which is itself chronological for BEAM
  // since sessionIds encode batch + turn ordinals.
  items.sort((a, b) => {
    const aKey = a.date || ""
    const bKey = b.date || ""
    if (aKey !== bKey) return aKey.localeCompare(bKey)
    return a.sessionId.localeCompare(b.sessionId, undefined, { numeric: true })
  })

  return items
    .map((item, i) => {
      const prefix = item.date ? `[${item.date}] ` : ""
      return `${i + 1}. ${prefix}${item.text}`
    })
    .join("\n")
}

/**
 * Ported verbatim from mem0's BEAM benchmark setup
 * (mem0ai/memory-benchmarks/benchmarks/beam/prompts.py) so our judging is
 * apples-to-apples with their published BEAM 1M / 10M numbers.
 */
export const BEAM_JUDGE_SYSTEM_PROMPT =
  "You are an expert evaluator assessing whether an AI assistant's response satisfies " +
  "specific rubric criteria. You must be objective, fair, and consistent. " +
  "Return ONLY valid JSON with the exact format requested."

function parseJsonResponse(response: string): Record<string, unknown> {
  const trimmed = response.trim()

  if (trimmed.startsWith("```")) {
    const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (codeFenceMatch?.[1]) {
      return JSON.parse(codeFenceMatch[1])
    }
  }

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0])
  }

  return JSON.parse(trimmed)
}

/**
 * Ported from mem0's get_beam_nugget_judge_prompt. Each rubric "nugget" is
 * scored independently on a 3-point scale by the judge LLM.
 */
export function buildBeamRubricJudgePrompt(
  question: string,
  nugget: string,
  llmResponse: string
): string {
  return `Evaluate whether the following LLM response demonstrates compliance with the specified RUBRIC CRITERION.

QUESTION:
${question}

LLM RESPONSE:
${llmResponse}

RUBRIC CRITERION:
${nugget}

SCORING GUIDELINES:

First, determine whether the rubric criterion is a POSITIVE requirement (the response SHOULD include something) or a NEGATIVE constraint (the response SHOULD NOT include something).

**For POSITIVE requirements** (response should contain, mention, or demonstrate something):
- **1.0 (Complete Compliance)**: The required element is present, accurate, and complete. The response fully and clearly satisfies the rubric criterion.
- **0.5 (Partial Compliance)**: The required element is partially present, has minor inaccuracies, or is incomplete. The core intent is present but not fully realized.
- **0.0 (No Compliance)**: The required element is missing, incorrect, or the response is entirely off-topic / non-responsive.

**For NEGATIVE constraints** (response should NOT contain or should avoid something):
- **1.0 (Complete Compliance)**: The response is responsive to the question AND the prohibited element is absent.
- **0.5 (Partial Compliance)**: The response is responsive but contains a borderline or ambiguous reference to the prohibited element.
- **0.0 (No Compliance)**: The prohibited element is present in the response, OR the response is non-responsive (off-topic, refusal, empty).

**Compound statement handling**: If the rubric criterion contains "and" or commas connecting multiple required elements:
- All elements present and correct = 1.0
- Some (but not all) elements present and correct = 0.5
- No elements present or correct = 0.0

EVALUATION RULES:
1. **Semantic tolerance**: Paraphrases and synonyms are acceptable. The response does not need to use the exact same words as the rubric.
2. **Numeric and date equivalence**: Treat equivalent representations as identical. "$68,000" = "68k" = "sixty-eight thousand dollars". "2 years" = "24 months". Prefer normalized comparison for numbers, currencies, dates, and durations.
3. **Case / punctuation / whitespace tolerance**: Differences in capitalization, punctuation, and whitespace must be ignored when comparing content.
4. **Hedging tolerance**: Do not penalize hedging language ("I think", "probably", "it seems"), passive voice, or verbosity if the substantive content satisfies the rubric criterion.
5. **Style neutrality**: Do not penalize for tone, formatting, or length unless the rubric criterion specifically requires a particular format.
6. **Responsiveness**: If the LLM response is completely off-topic or refuses to answer, score 0.0 for all criteria.
7. **Independence**: Evaluate this criterion in isolation — do not consider other rubric items.
8. **Specificity matters**: Vague or generic answers that could apply to any question score lower than specific, detailed answers.

STEP-BY-STEP EVALUATION:
Follow these steps in order:
1. **Understand the Requirement**: Read the rubric criterion and classify it as a positive requirement or a negative constraint.
2. **Parse Compound Statements**: If the criterion contains multiple sub-requirements joined by "and" or commas, identify each element separately.
3. **Check Compliance**: Compare the LLM response against each element, applying the tolerance rules above (semantic, numeric, case, hedging).
4. **Assign Score**: Use the appropriate scoring table (positive or negative) and compound-statement rule to determine the score.
5. **Provide Reasoning**: Write a concise explanation referencing which elements were or were not satisfied.

Return your evaluation as a JSON object with exactly two fields:
{"score": <0.0 or 0.5 or 1.0>, "reason": "<one concise sentence explaining your score>"}`
}

/**
 * Ported from mem0's _clamp_nugget_score. Snaps any numeric score the judge
 * returns to the nearest of {0.0, 0.5, 1.0}, instead of penalizing on exact
 * match failure.
 */
export function clampNuggetScore(raw: number): 0 | 0.5 | 1 {
  if (!Number.isFinite(raw)) return 0
  if (raw >= 0.75) return 1
  if (raw >= 0.25) return 0.5
  return 0
}

/**
 * Ported from mem0's judge_single_nugget response handling. If JSON parsing
 * works, clamp the score; otherwise fall back to scanning the raw text for
 * "1.0" / "0.5" markers.
 */
export function parseBeamRubricJudgeResponse(response: string): BeamRubricJudgeResult {
  try {
    const parsed = parseJsonResponse(response)
    const raw = typeof parsed.score === "number" ? parsed.score : Number(parsed.score)
    return {
      score: clampNuggetScore(raw),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    }
  } catch {
    const snippet = response.slice(0, 200)
    if (snippet.includes("1.0")) return { score: 1, reason: snippet }
    if (snippet.includes("0.5")) return { score: 0.5, reason: snippet }
    return { score: 0, reason: `Parse error: ${snippet}` }
  }
}
