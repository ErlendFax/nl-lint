import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { evaluateWithCache } from '../src/cache.mjs'

test('cache reuses exact requests, invalidates changes, and recovers corrupt entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-cache-'))
  const request = {
    model: 'jev-1.13.0',
    state: { file: 'example.tsx', source: '<p>Hello</p>' },
    questions: {
      example: { type: 'choice', instructions: 'Check this', criteria: { pass: 'OK' } },
    },
  }
  let calls = 0
  const evaluate = async (input) => {
    calls += 1
    return {
      model: input.model,
      answers: { example: { type: 'choice', choice: 'pass', probabilities: { pass: 1 } } },
    }
  }
  const run = (input = request, options = {}) =>
    evaluateWithCache(input, evaluate, { directory, ...options })
  try {
    assert.equal((await run()).cached, false)
    assert.equal((await run()).cached, true)
    assert.equal(calls, 1)
    await run({ ...request, state: { ...request.state, source: '<p>Changed</p>' } })
    await run({ ...request, model: 'jev-1.14.0' })
    await run({
      ...request,
      questions: { example: { ...request.questions.example, instructions: 'Updated rule' } },
    })
    assert.equal(calls, 4)
    assert.equal((await run(request, { refresh: true })).cached, false)
    assert.equal((await run()).cached, true)
    assert.equal(calls, 5)
    for (const file of await readdir(directory)) await writeFile(join(directory, file), '{broken')
    assert.equal((await run()).cached, false)
    assert.equal((await run()).cached, true)
    assert.equal(calls, 6)
    await run(request, { disabled: true })
    await run(request, { disabled: true })
    await run({ ...request, model: 'jev-latest' })
    await run({ ...request, model: 'jev-latest' })
    assert.equal(calls, 10)
    assert.equal(
      (await readdir(directory)).some((file) => file.endsWith('.tmp')),
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('malformed cache values are reevaluated, replaced, and then reused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nl-lint-cache-'))
  const request = {
    model: 'jev-1.13.0',
    questions: { example: { criteria: { pass: 'OK', violation: 'Bad', insufficient_context: 'Unknown' } } },
  }
  const answer = { type: 'choice', choice: 'pass', probabilities: { pass: 1, violation: 0, insufficient_context: 0 } }
  const result = { model: request.model, answers: { example: answer } }
  let calls = 0
  const run = () => evaluateWithCache(request, async () => { calls++; return result }, { directory })
  try {
    await run()
    const [entry] = await readdir(directory)
    const path = join(directory, entry)
    for (const malformed of [
      null, false, 42, 'invalid', [], {},
      { ...result, model: null },
      { ...result, model: 'jev-0.0.0' },
      { ...result, answers: null },
      { ...result, answers: {} },
      { ...result, answers: { example: null } },
      { ...result, answers: { example: { ...answer, choice: 'unknown' } } },
      { ...result, answers: { example: { ...answer, probabilities: null } } },
      { ...result, answers: { example: { ...answer, probabilities: { pass: 0.2, violation: 0.1, insufficient_context: 0 } } } },
      { ...result, answers: { example: { ...answer, confidence: 2 } } },
    ]) {
      await writeFile(path, JSON.stringify(malformed))
      const previousCalls = calls
      assert.deepEqual(await run(), { result, cached: false })
      assert.equal(calls, previousCalls + 1)
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result)
      assert.deepEqual(await run(), { result, cached: true })
      assert.equal(calls, previousCalls + 1)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('failed and incomplete results are never cached', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-cache-'))
  const request = {
    model: 'jev-1.13.0',
    questions: { example: { criteria: { pass: 'OK' } } },
  }
  try {
    await assert.rejects(
      evaluateWithCache(
        request,
        async () => {
          throw new Error('API failed')
        },
        { directory },
      ),
      /API failed/,
    )
    await assert.rejects(
      evaluateWithCache(request, async () => ({ model: request.model, answers: {} }), {
        directory,
      }),
      /incomplete/,
    )
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
