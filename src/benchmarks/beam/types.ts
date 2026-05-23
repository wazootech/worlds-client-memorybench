export type BeamScale = "1M" | "10M"

export interface BeamMessage {
  role: "user" | "assistant"
  id?: number
  content: string
  time_anchor?: string
  index?: string
  question_type?: string
}

export interface BeamBatch {
  batch_number: number
  time_anchor?: string | null
  turns: BeamMessage[][]
}

export type BeamChatFile = BeamBatch[] | Record<string, BeamBatch[]> | Record<string, BeamBatch[]>[]

export interface BeamProbingQuestion {
  question: string
  rubric: string[]
  difficulty?: string
  answer?: string
  ideal_answer?: string
  ideal_response?: string
  ideal_summary?: string
  [key: string]: unknown
}

export type BeamProbingQuestionsFile = Record<string, BeamProbingQuestion[]>
