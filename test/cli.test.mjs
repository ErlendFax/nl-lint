import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
test('CLI returns separate pass, rule failure and operational failure exit codes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nl-lint-cli-'))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
  try {
    await writeFile(join(cwd, 'test.ts'), 'export const value = 1')
    const config = probability => `export default { cache: false, rules: { example: 'No redundant comments' }, evaluate: async request => ({ model: request.model, answers: { example: { type: 'choice', choice: '${probability > 0.5 ? 'violation' : 'pass'}', probabilities: { violation: ${probability}, pass: ${1 - probability}, insufficient_context: 0 } } } }) }`
    await writeFile(join(cwd, 'nl-lint.config.mjs'), config(0.9))
    const failed = run('test.ts', '--json')
    assert.equal(failed.status, 1, failed.stderr)
    assert.equal(JSON.parse(failed.stdout).files[0].results[0].probabilities.violation, 0.9)
    await writeFile(join(cwd, 'nl-lint.config.mjs'), config(0.1))
    assert.equal(run('test.ts').status, 0)
    assert.equal(run('--config').status, 2)
    assert.equal(run('missing.ts').status, 2)
    assert.equal(run('--unknown').status, 2)
    assert.equal(run('--help').status, 0)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('CLI rejects unsupported explicit files before evaluation but skips them during discovery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nl-lint-inputs-'))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', TYPESAFE_MODEL: '' },
  })
  try {
    await writeFile(join(cwd, 'nl-lint.config.mjs'), `
      import { writeFileSync } from 'node:fs'
      export default { cache: false, rules: { example: 'Use descriptive names.' }, evaluate: async request => {
        writeFileSync('evaluated', request.state.file)
        return { model: request.model, answers: { example: { type: 'choice', choice: 'pass',
          probabilities: { violation: 0, pass: 1, insufficient_context: 0 } } } }
      } }
    `)
    await mkdir(join(cwd, 'src'))
    await mkdir(join(cwd, 'dist'))
    await mkdir(join(cwd, 'docs'))
    const supported = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].map(ext => `src/example.${ext}`)
    const unsupported = ['docs/readme.md', 'example.py', 'data.json', 'types.d.ts', 'types.d.mts', 'types.d.cts', 'dist/generated.js']
    for (const file of [...supported, ...unsupported]) await writeFile(join(cwd, file), 'export {}')
    await symlink(join(cwd, 'src/example.ts'), join(cwd, 'linked.ts'))

    for (const file of [...unsupported, 'linked.ts']) {
      for (const args of [[file], ['src/example.ts', file, '--json']]) {
        const result = run(...args)
        assert.equal(result.status, 2, `${args}: ${result.stderr}`)
        assert.equal(result.stdout, '')
        assert.ok(result.stderr.includes(file), result.stderr)
        assert.match(result.stderr, /JavaScript\/TypeScript|excluded|symbolic links/)
      }
    }
    assert.ok(!(await readdir(cwd)).includes('evaluated'), 'invalid selections must not evaluate any files')

    const explicit = run(...supported, '--json')
    assert.equal(explicit.status, 0, explicit.stderr)
    assert.deepEqual(JSON.parse(explicit.stdout).files.map(file => file.file), [...supported].sort())

    execFileSync('git', ['init', '--quiet'], { cwd })
    const discovered = run('.', '--json')
    assert.equal(discovered.status, 0, discovered.stderr)
    assert.deepEqual(JSON.parse(discovered.stdout).files.map(file => file.file), ['nl-lint.config.mjs', ...supported].sort())
    const empty = run('docs', '--json')
    assert.equal(empty.status, 0, empty.stderr)
    assert.deepEqual(JSON.parse(empty.stdout), { passed: true, files: [] })

    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Initial'], { cwd })
    for (const file of unsupported) await writeFile(join(cwd, file), 'Updated excluded file')
    const diff = run('--diff', '--json')
    assert.equal(diff.status, 0, diff.stderr)
    assert.deepEqual(JSON.parse(diff.stdout), { passed: true, files: [] })
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('CLI validates configuration before file selection and preserves valid empty runs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nl-lint-config-'))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', TYPESAFE_MODEL: '' },
  })
  const writeConfig = config => writeFile(join(cwd, 'nl-lint.config.mjs'), `export default ${config}`)
  const rules = "rules: { example: 'Use descriptive names.' }"
  try {
    execFileSync('git', ['init', '--quiet'], { cwd })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Initial'], { cwd })
    await mkdir(join(cwd, 'empty'))

    for (const [config, error] of [
      ['null', /default object/],
      ['[]', /default object/],
      ['{}', /at least one named rule/],
      ['{ rules: {} }', /at least one named rule/],
      ['{ rules: { example: {} } }', /requires instructions/],
      ["{ rules: { example: { instructions: 'Check names.', criteria: {} } } }", /criteria/],
      ["{ rules: { example: { instructions: 'Check names.', threshold: 2 } } }", /threshold/],
      ["{ rules: { example: { instructions: 'Check names.', title: 1 } } }", /title/],
      ["{ rules: { example: { instructions: 'Check names.', message: false } } }", /message/],
      [`{ ${rules}, threshold: -1 }`, /threshold/],
      [`{ ${rules}, model: '' }`, /model/],
      [`{ ${rules}, timeoutMs: 0 }`, /timeoutMs/],
      [`{ ${rules}, cache: 42 }`, /cache/],
      [`{ ${rules}, refresh: 'yes' }`, /refresh/],
      [`{ ${rules}, apiKey: 42 }`, /apiKey/],
      [`{ ${rules}, evaluate: true }`, /evaluate/],
    ]) {
      await writeConfig(config)
      for (const selection of ['empty', '--diff', 'missing.ts']) {
        const result = run(selection)
        assert.equal(result.status, 2, `${config}: ${selection}: ${result.stderr}`)
        assert.equal(result.stdout, '')
        assert.match(result.stderr, error)
      }
    }

    for (const config of [
      `{ ${rules} }`,
      `{ ${rules}, evaluate: async () => { throw new Error('Empty selections must not evaluate.') } }`,
    ]) {
      await writeConfig(config)
      for (const selection of ['empty', '--diff']) {
        const result = run(selection)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stderr, '')
        assert.deepEqual(JSON.parse(result.stdout), { passed: true, files: [] })
      }
    }

    await writeConfig(`{ ${rules}, cache: 42, refresh: 'yes' }`)
    const overridden = run('--diff', '--no-cache', '--refresh')
    assert.equal(overridden.status, 0, overridden.stderr)
    assert.deepEqual(JSON.parse(overridden.stdout), { passed: true, files: [] })
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('CLI reports version, arguments, and missing config without internal errors', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nl-lint-help-'))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
  try {
    const version = run('--version')
    assert.equal(version.status, 0, version.stderr)
    assert.match(version.stdout, /^nl-lint \d+\.\d+\.\d+\n$/)
    const unknown = run('--unknown')
    assert.equal(unknown.status, 2)
    assert.match(unknown.stderr, /Unknown option.*--unknown/)
    const missing = run('example.ts')
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /No nl-lint.config.mjs found.*Create.*--config/)
    assert.doesNotMatch(missing.stderr, /Cannot find module/)
    const explicit = run('example.ts', '--config', 'absent.mjs')
    assert.match(explicit.stderr, /Config not found.*absent.mjs/)
    await writeFile(join(cwd, 'nl-lint.config.mjs'), "import './missing-dependency.mjs'; export default {}")
    assert.match(run('example.ts').stderr, /missing-dependency.mjs/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('CLI finds the nearest ancestor config while keeping input and explicit config paths relative to cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nl-lint-discovery-'))
  const child = join(cwd, 'src/nested')
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: child, encoding: 'utf8' })
  const config = title => `export default {cache:false,rules:{example:{instructions:'Check names.',title:'${title}'}},evaluate:async request=>({model:request.model,answers:{example:{type:'choice',choice:'pass',probabilities:{violation:0,pass:1,insufficient_context:0}}}})}`
  try {
    await mkdir(child, { recursive: true })
    await writeFile(join(child, 'example.ts'), 'export {}')
    await writeFile(join(cwd, 'nl-lint.config.mjs'), config('root'))
    const inherited = run('example.ts', '--json')
    assert.equal(inherited.status, 0, inherited.stderr)
    assert.equal(JSON.parse(inherited.stdout).files[0].file, 'example.ts')
    assert.equal(JSON.parse(inherited.stdout).files[0].results[0].title, 'root')
    await writeFile(join(cwd, 'src/nl-lint.config.mjs'), config('nearest'))
    assert.equal(JSON.parse(run('example.ts', '--json').stdout).files[0].results[0].title, 'nearest')
    assert.equal(JSON.parse(run('example.ts', '--json', '--config', '../../nl-lint.config.mjs').stdout).files[0].results[0].title, 'root')
    await writeFile(join(cwd, 'src/nl-lint.config.mjs'), 'export default {rules:{}}')
    assert.equal(run('example.ts').status, 2, 'an invalid nearest config must not fall back to an ancestor')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('CLI summarizes review outcomes and keeps progress out of JSON and success output on error', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nl-lint-output-'))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
  try {
    await writeFile(join(cwd, 'one.ts'), 'export {}')
    await writeFile(join(cwd, 'two.ts'), 'export {}')
    await writeFile(join(cwd, 'nl-lint.config.mjs'), `export default {
      cache:false,rules:{unknown:'Check names.',below:'Check comments.'},evaluate:async request=>({model:request.model,answers:{
        unknown:{type:'choice',choice:'insufficient_context',probabilities:{violation:0.1,pass:0.1,insufficient_context:0.8}},
        below:{type:'choice',choice:'violation',probabilities:{violation:0.6,pass:0.4,insufficient_context:0}}
      }})}`)
    const reviewed = run('one.ts', '--verbose')
    assert.equal(reviewed.status, 0, reviewed.stderr)
    assert.match(reviewed.stdout, /^REVIEW one.ts/)
    assert.match(reviewed.stdout, /0 rule failures; 2 need review/)
    assert.match(reviewed.stderr, /Checking 1\/1: one.ts/)
    const json = run('one.ts', '--json', '--verbose')
    assert.equal(json.status, 0, json.stderr)
    assert.equal(json.stderr, '')
    assert.equal(JSON.parse(json.stdout).passed, true)
    const failed = run('one.ts', 'two.ts', '--verbose', '--config', 'error.mjs')
    assert.equal(failed.status, 2)
    assert.equal(failed.stdout, '')
    await writeFile(join(cwd, 'error.mjs'), `export default {cache:false,rules:{example:'Check names.'},evaluate:async request=>{
      if(request.state.file==='two.ts') throw new Error('service unavailable')
      return {model:request.model,answers:{example:{type:'choice',choice:'pass',probabilities:{violation:0,pass:1,insufficient_context:0}}}}
    }}`)
    const partial = run('one.ts', 'two.ts', '--verbose', '--config', 'error.mjs')
    assert.equal(partial.status, 2)
    assert.equal(partial.stdout, '')
    assert.match(partial.stderr, /Checking 2\/2: two.ts/)
    assert.match(partial.stderr, /service unavailable/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('CLI gives one actionable Git error outside a repository', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nl-lint-git-error-'))
  try {
    await writeFile(join(cwd, 'nl-lint.config.mjs'), "export default {rules:{example:'Check names.'}}")
    for (const selection of ['.', '--diff']) {
      const result = spawnSync(process.execPath, [cli, selection], { cwd, encoding: 'utf8' })
      assert.equal(result.status, 2)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /Git repository.*individual source files/)
      assert.equal(result.stderr.trim().split('\n').length, 1)
      assert.doesNotMatch(result.stderr, /fatal:|Command failed:/)
    }
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
