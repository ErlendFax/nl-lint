export type Choice = 'violation' | 'pass' | 'insufficient_context'

export interface Question {
  type: 'choice'
  instructions: string | string[]
  criteria: Record<Choice, string>
}

export interface Rule {
  instructions: string | string[]
  criteria?: Record<Choice, string>
  title?: string
  message?: string
  threshold?: number
}

export type Rules = Record<string, string | Rule>

export interface Request {
  model: string
  state: { file: string; source: string }
  questions: Record<string, Question>
}

export interface Answer {
  type: 'choice'
  choice: Choice
  probabilities: Record<Choice, number>
  confidence?: number
}

export interface Response {
  model: string
  answers: Record<string, Answer>
  usage?: { input_tokens: number; output_tokens: number }
}

export interface Config {
  rules: Rules
  threshold?: number
  model?: string
  apiKey?: string
  timeoutMs?: number
  cache?: boolean | string
  refresh?: boolean
  evaluate?: (request: Request) => Promise<Response>
}

export interface Result {
  id: string
  title: string
  message: string
  threshold: number
  failed: boolean
  choice: Choice
  probabilities: Record<Choice, number>
  confidence?: number
}

export interface Report {
  file: string
  model: string
  passed: boolean
  cached: boolean
  results: Result[]
  usage?: Response['usage']
}

export const defaults: Readonly<{ model: string; threshold: number; timeoutMs: number }>
export const defaultCriteria: Readonly<Record<Choice, string>>
export function lintSource(options: Config & { file: string; source: string }): Promise<Report>
