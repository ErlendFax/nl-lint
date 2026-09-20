import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const cacheDirectory = join(process.cwd(), '.cache/nl-lint')

function validResult(result, request) {
  return (
    typeof result?.model === 'string' &&
    Object.keys(request.questions).every((id) => {
      const answer = result.answers?.[id]
      return (
        answer?.type === 'choice' &&
        Object.hasOwn(request.questions[id].criteria, answer.choice) &&
        (answer.confidence === undefined || (Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1)) &&
        Math.abs(Object.keys(request.questions[id].criteria).reduce((sum, key) => sum + (answer.probabilities?.[key] ?? NaN), 0) - 1) <= 0.001 &&
        Object.keys(request.questions[id].criteria).every((choice) => {
          const probability = answer.probabilities?.[choice]
          return typeof probability === 'number' && probability >= 0 && probability <= 1
        })
      )
    })
  )
}

export async function evaluateWithCache(
  request,
  evaluate,
  { directory = cacheDirectory, refresh = false, disabled = false } = {},
) {
  // Moving aliases must not keep serving results from an older model version.
  const cacheable = !disabled && /^jev-\d+\.\d+\.\d+$/.test(request.model)
  const key = createHash('sha256')
    .update(JSON.stringify({ version: 1, request }))
    .digest('hex')
  const path = join(directory, `${key}.json`)
  if (cacheable && !refresh) {
    try {
      const result = JSON.parse(await readFile(path, 'utf8'))
      if (result?.model === request.model && validResult(result, request)) {
        return { result, cached: true }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }

  const result = await evaluate(request)
  if (!validResult(result, request)) throw new Error('TypeSafe returned an incomplete result.')
  if (cacheable && result.model === request.model) {
    await mkdir(directory, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`)
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return { result, cached: false }
}
