// Opt-in live check. Sends only synthetic source and uses a temporary cache.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lintSource, defaults } from '../src/index.mjs'

if (!process.env.TYPESAFE_API_KEY) throw new Error('Export TYPESAFE_API_KEY to run this optional live check.')
const cache = await mkdtemp(join(tmpdir(), 'nl-lint-live-'))
const rule = 'The source must not call console.log. Other console methods are allowed. Mentions inside comments or string literals are allowed.'
const functions = Array.from({ length: 120 }, (_, index) => `export function value${index}(input) { return input * ${index + 1} }`).join('\n')
const cases = [
  { file: 'small-pass.ts', source: 'export const sum = (a: number, b: number) => a + b', failed: false },
  { file: 'small-fail.ts', source: 'export function save(value: string) { console.log(value); return value }', failed: true },
  { file: 'comment.ts', source: '// Avoid console.log in production.\nexport const debugMethod = "console.log"', failed: false },
  { file: 'error.ts', source: 'export function report(error: Error) { console.error(error.message) }', failed: false },
  { file: 'large-pass.js', source: functions, failed: false },
  { file: 'large-fail.js', source: `${functions}\nconsole.log(value119(2))`, failed: true },
]
try {
  const measured = []
  for (const sample of cases) {
    const start = performance.now()
    const report = await lintSource({ ...sample, rules: { no_debug_logs: rule }, model: defaults.model, cache })
    assert.equal(report.cached, false)
    measured.push({ file: sample.file, bytes: Buffer.byteLength(sample.source), uncachedMs: Math.round(performance.now() - start),
      expectedFailure: sample.failed, actualFailure: !report.passed, choice: report.results[0].choice,
      violation: report.results[0].probabilities.violation, usage: report.usage })
  }
  const start = performance.now()
  for (const sample of cases) {
    const report = await lintSource({ ...sample, rules: { no_debug_logs: rule }, model: defaults.model, cache,
      evaluate: async () => { throw new Error('Expected cache hit') } })
    assert.equal(report.cached, true)
  }
  console.log(JSON.stringify({ date: new Date().toISOString(), node: process.version, model: defaults.model,
    cases: measured, labeledMatches: measured.filter(item => item.expectedFailure === item.actualFailure).length,
    totalCases: cases.length, sequentialUncachedMs: measured.reduce((sum, item) => sum + item.uncachedMs, 0),
    sequentialCachedMs: Math.round(performance.now() - start),
    note: 'One run of six synthetic files; not a representative accuracy or production latency guarantee.' }, null, 2))
} finally { await rm(cache, { recursive: true, force: true }) }
