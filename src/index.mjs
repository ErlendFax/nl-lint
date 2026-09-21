import { join } from 'node:path'
import { evaluateWithCache } from './cache.mjs'
import { prepareConfig } from './config.mjs'

export { defaults, defaultCriteria } from './config.mjs'

/** Evaluate one whole source file; imports are not read automatically. */
export async function lintSource({ file, source, ...config } = {}) {
  if (typeof file !== 'string' || !file || typeof source !== 'string') throw new TypeError('file and source must be strings.')
  const { model, apiKey, timeoutMs, cache, refresh, evaluate, compiled } = prepareConfig(config)
  const request = { model, state: { file, source }, questions: Object.fromEntries(compiled.map(r => [r.id, r.question])) }
  const { result, cached } = await evaluateWithCache(request, evaluate ?? (async request => {
    if (!apiKey) throw new Error('Missing TYPESAFE_API_KEY environment variable.')
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}.`)
    return response.json()
  }), { directory: typeof cache === 'string' ? cache : join(process.cwd(), '.cache/nl-lint'), disabled: cache === false, refresh })
  const results = compiled.map(rule => {
    const answer = result.answers[rule.id]
    const failed = answer.probabilities.violation >= rule.threshold
    return { id: rule.id, title: rule.title, question: rule.question.instructions.slice(0, -1), message: rule.message, threshold: rule.threshold,
      failed, choice: answer.choice, probabilities: answer.probabilities,
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) }
  })
  return { file, model: result.model, passed: !results.some(r => r.failed), cached, results,
    ...(result.usage === undefined ? {} : { usage: result.usage }) }
}
