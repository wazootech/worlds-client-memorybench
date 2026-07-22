/**
 * 5-question Worlds agent smoke with full JSONL trace logging.
 *
 * Uses indexed LibSQL DBs from a prior MemoryBench run (default: smoke-005).
 *
 *   bun --env-file=.env.local run scripts/worlds-agent-smoke.ts
 *   bun --env-file=.env.local run scripts/worlds-agent-smoke.ts --check-only
 *   bun --env-file=.env.local run scripts/worlds-agent-smoke.ts --replay data/agent-traces/latest.jsonl
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateText, tool, stepCountIs } from "ai"
import { z } from "zod"
import type { Client } from "@worlds/client"
import { LoCoMoBenchmark } from "../src/benchmarks/locomo"
import { WorldsProvider } from "../src/providers/worlds"
import { config } from "../src/utils/config"
import { logger } from "../src/utils/logger"

const DEFAULT_RUN_SUFFIX = "smoke-005"
const DEFAULT_MODEL = "gemini-2.5-flash"
const TRACE_DIR = join(process.cwd(), "data", "agent-traces")

const SYSTEM_PROMPT = `You answer questions about a long conversation stored in a Worlds knowledge graph.

Tool order:
1. worlds_search — default first step. Use short keywords and proper names, not full sentences.
2. worlds_sparql — optional. Use when you need structured claim fields (claimSubject, claimText, session dates) or filters search cannot express.

Rules:
- Use Session Date on results for temporal questions.
- Cite evidence from tool results; do not invent facts.
- When you have enough evidence, answer concisely in plain text (no tool calls).`

type TraceRecord = {
  questionId: string
  question: string
  containerTag: string
  groundTruth?: string
  startedAt: string
  finishedAt?: string
  error?: string
  finalText?: string
  steps?: unknown[]
  toolCalls?: unknown[]
  replayed?: boolean
}

function parseArgs(argv: string[]) {
  const checkOnly = argv.includes("--check-only")
  const replayIdx = argv.indexOf("--replay")
  const replayPath = replayIdx >= 0 ? argv[replayIdx + 1] : undefined
  const suffixIdx = argv.indexOf("--run-suffix")
  const runSuffix = suffixIdx >= 0 ? argv[suffixIdx + 1]! : DEFAULT_RUN_SUFFIX
  const limitIdx = argv.indexOf("--limit")
  const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1]!, 10) : 5
  return { checkOnly, replayPath, runSuffix, limit }
}

async function checkBilling(apiKey: string): Promise<void> {
  const google = createGoogleGenerativeAI({ apiKey })
  await generateText({
    model: google(DEFAULT_MODEL),
    prompt: "Reply with exactly: ok",
    maxOutputTokens: 8,
  })
  logger.success("Billing check passed (generateText)")
}

function createTools(
  getClient: () => Promise<Client>,
  provider: WorldsProvider,
  containerTag: string,
  traceSink: (entry: Record<string, unknown>) => void
) {
  return {
    worlds_search: tool({
      description:
        "Hybrid keyword + vector search over conversation messages. Use first. " +
        "Query: short keywords and person names (e.g. \"Caroline LGBTQ support group\"). " +
        "Returns messages with Session Date, Speaker, and relevance score when available.",
      inputSchema: z.object({
        query: z.string().describe("Short search query with names and keywords"),
      }),
      execute: async ({ query }) => {
        const started = Date.now()
        const results = await provider.search(query, { containerTag })
        const payload = { resultCount: results.length, results: results.slice(0, 15) }
        traceSink({ tool: "worlds_search", query, ms: Date.now() - started, ...payload })
        return payload
      },
    }),
    worlds_sparql: tool({
      description:
        "Run a read-only SPARQL SELECT on the graph. Use after search when you need structured " +
        "worlds:FactClaim / worlds:EventClaim rows (claimText, claimSubject, claimAction, claimObject) " +
        "or session schema:dateCreated. Always include LIMIT (≤ 20). Prefixes are pre-declared in the store.",
      inputSchema: z.object({
        query: z.string().describe("SPARQL SELECT query, LIMIT ≤ 20"),
      }),
      execute: async ({ query }) => {
        const started = Date.now()
        const client = await getClient()
        const response = await client.sparql({ query })
        const payload =
          response.kind === "select"
            ? {
                kind: response.kind,
                bindings: response.data.results.bindings.slice(0, 20),
                totalBindings: response.data.results.bindings.length,
              }
            : { kind: response.kind, response }
        traceSink({ tool: "worlds_sparql", query, ms: Date.now() - started, ...payload })
        return payload
      },
    }),
  }
}

async function loadQuestions(limit: number): Promise<
  Array<{ questionId: string; question: string; groundTruth: string }>
> {
  const benchmark = new LoCoMoBenchmark()
  await benchmark.load()
  return benchmark
    .getQuestions()
    .filter((q) => /^conv-26-q\d+$/.test(q.questionId))
    .slice(0, limit)
    .map((q) => ({
      questionId: q.questionId,
      question: q.question,
      groundTruth: benchmark.getGroundTruth(q.questionId),
    }))
}

async function runAgentForQuestion(opts: {
  apiKey: string
  provider: WorldsProvider
  getClient: () => Promise<Client>
  questionId: string
  question: string
  containerTag: string
  groundTruth?: string
  tracePath: string
}): Promise<TraceRecord> {
  const record: TraceRecord = {
    questionId: opts.questionId,
    question: opts.question,
    containerTag: opts.containerTag,
    groundTruth: opts.groundTruth,
    startedAt: new Date().toISOString(),
  }

  const toolTrace: Record<string, unknown>[] = []
  const tools = createTools(opts.getClient, opts.provider, opts.containerTag, (e) => toolTrace.push(e))

  const google = createGoogleGenerativeAI({ apiKey: opts.apiKey })

  try {
    const result = await generateText({
      model: google(DEFAULT_MODEL),
      system: SYSTEM_PROMPT,
      prompt: opts.question,
      tools,
      stopWhen: stepCountIs(8),
      onStepFinish: (step) => {
        record.steps = [...(record.steps ?? []), step]
      },
    })

    record.finalText = result.text
    record.toolCalls = toolTrace
    record.finishedAt = new Date().toISOString()
    await appendFile(opts.tracePath, `${JSON.stringify(record)}\n`)
    return record
  } catch (err) {
    record.error = String(err)
    record.toolCalls = toolTrace
    record.finishedAt = new Date().toISOString()
    await appendFile(opts.tracePath, `${JSON.stringify(record)}\n`)
    throw err
  }
}

async function main() {
  const { checkOnly, replayPath, runSuffix, limit } = parseArgs(process.argv.slice(2))
  const apiKey = config.googleApiKey
  if (!apiKey) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY required")
  }

  if (checkOnly) {
    await checkBilling(apiKey)
    return
  }

  if (replayPath) {
    logger.info(`Replay mode: ${replayPath} (LLM-only re-run not yet wired — use live run to capture traces)`)
    return
  }

  await mkdir(TRACE_DIR, { recursive: true })
  const traceId = `agent-${runSuffix}-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const tracePath = join(TRACE_DIR, `${traceId}.jsonl`)
  const latestPath = join(TRACE_DIR, "latest.jsonl")

  await checkBilling(apiKey)

  const provider = new WorldsProvider()
  await provider.initialize({ apiKey })

  const getClient = (containerTag: string) => provider.getClientForContainer(containerTag)

  const questions = await loadQuestions(limit)
  logger.info(`Running ${questions.length} agent questions → ${tracePath}`)

  let ok = 0
  for (const q of questions) {
    const containerTag = `${q.questionId}-${runSuffix}`
    logger.info(`[${q.questionId}] ${q.question.slice(0, 60)}… (${containerTag})`)
    try {
      await runAgentForQuestion({
        apiKey,
        provider,
        getClient: () => getClient(containerTag),
        questionId: q.questionId,
        question: q.question,
        containerTag,
        groundTruth: q.groundTruth,
        tracePath,
      })
      ok++
      logger.success(`[${q.questionId}] done`)
    } catch (err) {
      logger.error(`[${q.questionId}] failed: ${err}`)
      break
    }
  }

  await writeFile(latestPath, await Bun.file(tracePath).text())
  logger.info(`Traces: ${tracePath} (also ${latestPath})`)
  logger.info(`Completed ${ok}/${questions.length}`)
}

main().catch((err) => {
  logger.error(String(err))
  process.exit(1)
})
