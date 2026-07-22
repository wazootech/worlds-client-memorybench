import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateText } from "ai"
import type { UnifiedSession } from "../../types/unified"
import { TURTLE_PREFIXES, RDF, PROV, WORLDS } from "./ontology"
import { logger } from "../../utils/logger"

const EXTRACTION_MODEL = "gemini-2.5-flash"
const EXTRACTION_MAX_RETRIES = 4
const EXTRACTION_BASE_DELAY_MS = 1500

const CLAIM_TYPE_MAP: Record<string, string> = {
  fact: WORLDS.FactClaim,
  event: WORLDS.EventClaim,
  preference: WORLDS.PreferenceClaim,
  relationship: WORLDS.RelationshipClaim,
  plan: WORLDS.PlanClaim,
}

interface ExtractedClaim {
  type: string
  subject: string
  action: string
  object: string
  claimText: string
  when?: string
  where?: string
}

export interface ExtractFactsOptions {
  /** When set, successful extractions are cached under this directory. */
  cacheDir?: string
}

function sessionContentHash(session: UnifiedSession): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: session.sessionId,
        messages: session.messages,
        metadata: session.metadata,
      })
    )
    .digest("hex")
}

function buildFactExtractionPrompt(session: UnifiedSession): string {
  const speakerA = (session.metadata?.speakerA as string) || "Speaker A"
  const speakerB = (session.metadata?.speakerB as string) || "Speaker B"
  const date =
    (session.metadata?.formattedDate as string) ||
    (session.metadata?.date as string) ||
    "Unknown date"

  const conversation = session.messages
    .map((m) => {
      const speaker = m.speaker || m.role
      return `${speaker}: ${m.content}`
    })
    .join("\n")

  return `You are a knowledge extraction system. Read the conversation and extract every distinct fact, event, preference, relationship, and plan/decision into a JSON array.

Conversation Date: ${date}
Participants: ${speakerA}, ${speakerB}

<conversation>
${conversation}
</conversation>

For each extracted item, output a JSON object with these fields:
- "type": one of "fact", "event", "preference", "relationship", "plan"
- "subject": who or what (use the person's actual name, e.g. "${speakerA}")
- "action": what they did, feel, prefer, plan, etc. (verb phrase)
- "object": the target, thing, or detail
- "claimText": a single self-contained sentence summarizing this claim (must be understandable without context)
- "when": (optional) when it happened — resolve relative dates like "yesterday" or "last year" using the Conversation Date
- "where": (optional) location if mentioned

Rules:
- Extract ONLY from what was explicitly stated
- Use speakers' actual names ("${speakerA}", "${speakerB}"), never "the user"
- Resolve all relative dates to absolute dates using the Conversation Date
- Each claim must be independently understandable
- Include ALL facts, even minor personal details — more is better than less
- The "claimText" field is the most important: it should be a complete, searchable sentence

Respond with ONLY a JSON array. No markdown fences, no commentary.

Example output:
[
  {"type":"event","subject":"${speakerA}","action":"applied to","object":"adoption agencies","claimText":"${speakerA} applied to adoption agencies.","when":"March 15, 2023"},
  {"type":"fact","subject":"${speakerB}","action":"works as","object":"a nurse","claimText":"${speakerB} works as a nurse."},
  {"type":"preference","subject":"${speakerA}","action":"enjoys","object":"painting landscapes","claimText":"${speakerA} enjoys painting landscapes."}
]`
}

function escapeTurtle(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

/**
 * Converts extracted claims into RDF Turtle triples linked to their source session.
 * Uses deterministic URIs: urn:claim:{sessionId}/{index}
 */
export function claimsToTurtle(claims: ExtractedClaim[], sessionId: string): string {
  if (claims.length === 0) return ""

  const sessionUri = `urn:session:${sessionId}`
  const lines: string[] = [TURTLE_PREFIXES, ""]

  for (let i = 0; i < claims.length; i++) {
    const c = claims[i]
    const claimUri = `urn:claim:${sessionId}/${i}`
    const typeIri = CLAIM_TYPE_MAP[c.type] || WORLDS.Claim

    lines.push(
      `<${claimUri}> <${RDF.type}> <${typeIri}> .`,
      `<${claimUri}> <${RDF.type}> <${WORLDS.Claim}> .`,
      `<${claimUri}> <${WORLDS.claimSubject}> "${escapeTurtle(c.subject)}" .`,
      `<${claimUri}> <${WORLDS.claimAction}> "${escapeTurtle(c.action)}" .`,
      `<${claimUri}> <${WORLDS.claimObject}> "${escapeTurtle(c.object)}" .`,
      `<${claimUri}> <${WORLDS.claimText}> "${escapeTurtle(c.claimText)}" .`,
      `<${claimUri}> <${PROV.wasDerivedFrom}> <${sessionUri}> .`
    )
    if (c.when) {
      lines.push(`<${claimUri}> <${WORLDS.claimWhen}> "${escapeTurtle(c.when)}" .`)
    }
    if (c.where) {
      lines.push(`<${claimUri}> <${WORLDS.claimWhere}> "${escapeTurtle(c.where)}" .`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function generateExtractionJson(apiKey: string, session: UnifiedSession): Promise<string> {
  const prompt = buildFactExtractionPrompt(session)
  const google = createGoogleGenerativeAI({ apiKey })

  let lastErr: unknown
  for (let attempt = 0; attempt < EXTRACTION_MAX_RETRIES; attempt++) {
    try {
      const { text } = await generateText({
        model: google(EXTRACTION_MODEL),
        prompt,
        maxTokens: 4000,
        temperature: 0,
      } as Parameters<typeof generateText>[0])
      return text
    } catch (err) {
      lastErr = err
      const wait = EXTRACTION_BASE_DELAY_MS * 2 ** attempt
      logger.warn(
        `Fact extraction attempt ${attempt + 1}/${EXTRACTION_MAX_RETRIES} failed for ${session.sessionId}: ${err}. Retrying in ${wait}ms`
      )
      await sleep(wait)
    }
  }
  throw lastErr
}

/**
 * Extracts structured facts from a conversation session using Gemini,
 * then converts them to RDF Turtle triples.
 */
export async function extractFactsToTurtle(
  apiKey: string,
  session: UnifiedSession,
  options?: ExtractFactsOptions
): Promise<string> {
  const hash = sessionContentHash(session)
  const cacheDir = options?.cacheDir
  const cacheFile = cacheDir ? join(cacheDir, `${hash}.json`) : undefined

  if (cacheFile) {
    try {
      const raw = await readFile(cacheFile, "utf-8")
      const cached = JSON.parse(raw) as { hash: string; turtle: string }
      if (cached.hash === hash && typeof cached.turtle === "string") {
        logger.debug(`Using cached fact extraction for ${session.sessionId}`)
        return cached.turtle
      }
    } catch {
      /* no cache */
    }
  }

  const text = await generateExtractionJson(apiKey, session)

  let claims: ExtractedClaim[]
  try {
    const cleaned = text
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/```\s*$/, "")
    claims = JSON.parse(cleaned) as ExtractedClaim[]
    if (!Array.isArray(claims)) {
      logger.warn(`Fact extraction for ${session.sessionId}: response was not an array`)
      return ""
    }
  } catch (err) {
    logger.warn(`Fact extraction for ${session.sessionId}: failed to parse JSON: ${err}`)
    logger.debug(`Raw extraction response: ${text.slice(0, 500)}`)
    return ""
  }

  const valid = claims.filter(
    (c) => c.type && c.subject && c.claimText && typeof c.claimText === "string"
  )

  logger.debug(
    `Extracted ${valid.length} claims from session ${session.sessionId} (${claims.length} raw)`
  )

  const turtle = claimsToTurtle(valid, session.sessionId)

  if (cacheFile && turtle) {
    try {
      await mkdir(cacheDir!, { recursive: true })
      await writeFile(cacheFile, JSON.stringify({ hash, turtle }), "utf-8")
    } catch (err) {
      logger.warn(`Failed to write extraction cache for ${session.sessionId}: ${err}`)
    }
  }

  return turtle
}
