import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { lintSource, defaults } from '../src/index.mjs'

const answer = (violation, pass = 1 - violation, insufficient_context = 0) => ({
  type: 'choice', choice: violation >= pass && violation >= insufficient_context ? 'violation' : pass >= insufficient_context ? 'pass' : 'insufficient_context',
  probabilities: { violation, pass, insufficient_context }, confidence: 0.7,
})
const input = { file: 'test.ts', source: '// add one\nx++', rules: { comments: 'Comments must add useful information.' }, cache: false }
const evaluate = value => async request => ({ model: request.model, answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, value])) })

test('threshold is inclusive, overrides shared default, and preserves uncertainty and probabilities', async () => {
  for (const [probability, failed] of [[0.7999, false], [0.8, true], [1, true]]) {
    const report = await lintSource({ ...input, evaluate: evaluate(answer(probability)) })
    assert.equal(report.passed, !failed)
    assert.equal(report.results[0].failed, failed)
    assert.equal(report.results[0].probabilities.violation, probability)
    assert.equal(report.results[0].confidence, 0.7)
  }
  const report = await lintSource({ ...input, threshold: 0.7, rules: {
    first: 'Check this', second: { instructions: 'Check that', threshold: 0.9 },
  }, evaluate: evaluate(answer(0.8)) })
  assert.deepEqual(report.results.map(r => r.failed), [true, false])
  const uncertain = await lintSource({ ...input, evaluate: evaluate(answer(0.1, 0.1, 0.8)) })
  assert.equal(uncertain.passed, true)
  assert.equal(uncertain.results[0].choice, 'insufficient_context')
  assert.equal((await lintSource({ ...input, threshold: 0.2, evaluate: evaluate(answer(0.3, 0.1, 0.6)) })).passed, false)
  assert.equal(defaults.threshold, 0.8)
})

test('batches custom rules and treats source as data', async () => {
  let calls = 0
  const rules = { comments: { instructions: ['Comments must explain intent.'] }, naming: { instructions: ['Use descriptive names.'] } }
  await lintSource({ ...input, rules, evaluate: async request => {
    calls++
    assert.deepEqual(request.state, { file: input.file, source: input.source })
    assert.equal(Object.keys(request.questions).length, 2)
    for (const [id, q] of Object.entries(request.questions)) {
      assert.deepEqual(q.instructions.slice(0, -1), rules[id].instructions)
      assert.match(q.instructions.at(-1), /data to evaluate/)
    }
    return evaluate(answer(0.1))(request)
  } })
  assert.equal(calls, 1)
})

test('threshold/title changes reuse probabilities, while source changes re-evaluate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nl-lint-'))
  let calls = 0
  const options = { ...input, model: defaults.model, cache: directory, evaluate: async request => { calls++; return evaluate(answer(0.8))(request) } }
  try {
    assert.equal((await lintSource(options)).passed, false)
    const second = await lintSource({ ...options, threshold: 0.9, rules: { comments: { instructions: input.rules.comments, title: 'Other title' } } })
    assert.equal(second.passed, true)
    assert.equal(second.cached, true)
    assert.equal(calls, 1)
    await lintSource({ ...options, source: 'changed' })
    assert.equal(calls, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('rejects bad settings and invalid API results instead of passing', async () => {
  for (const value of [-1, 1.1, NaN, Infinity, '0.8']) {
    await assert.rejects(lintSource({ ...input, threshold: value }), /threshold/)
  }
  await assert.rejects(lintSource({ ...input, rules: {} }), /at least one/)
  await assert.rejects(lintSource({ ...input, rules: { bad: '' } }), /instructions/)
  for (const [options, error] of [
    [{ model: '' }, /model/],
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ cache: 42 }, /cache/],
    [{ refresh: 'yes' }, /refresh/],
    [{ apiKey: 42 }, /apiKey/],
    [{ evaluate: true }, /evaluate/],
    [{ rules: { bad: { instructions: 'Check names.', title: 1 } } }, /title/],
    [{ rules: { bad: { instructions: 'Check names.', message: false } } }, /message/],
  ]) {
    await assert.rejects(lintSource({ ...input, ...options }), error)
  }
  await assert.rejects(lintSource({ ...input, evaluate: async () => ({ model: defaults.model, answers: {} }) }), /incomplete/)
  await assert.rejects(lintSource({ ...input, evaluate: async () => { throw new Error('service unavailable') } }), /service unavailable/)
  await assert.rejects(lintSource({ ...input, apiKey: '' }), /TYPESAFE_API_KEY/)
})

test('HTTP contract and error handling', async t => {
  // Node 22.0 initializes fetch lazily; read it before replacing the property.
  assert.equal(typeof globalThis.fetch, 'function')
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(options.headers.Authorization, 'Bearer test-key')
    assert.equal(options.method, 'POST')
    assert.ok(options.signal instanceof AbortSignal)
    return { ok: true, json: () => evaluate(answer(0.9))(JSON.parse(options.body)) }
  })
  assert.equal((await lintSource({ ...input, apiKey: 'test-key' })).passed, false)
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: false, status: 429 }))
  await assert.rejects(lintSource({ ...input, apiKey: 'test-key' }), /HTTP 429/)
})


test('malformed probability distributions never become successful reports', async () => {
  for (const probabilities of [
    { violation: 0.1, pass: 0.1, insufficient_context: 0.1 },
    { violation: NaN, pass: 1, insufficient_context: 0 },
    { violation: -0.1, pass: 1.1, insufficient_context: 0 },
  ]) {
    await assert.rejects(lintSource({ ...input, evaluate: evaluate({ ...answer(0.1), probabilities }) }), /incomplete/)
  }
})
