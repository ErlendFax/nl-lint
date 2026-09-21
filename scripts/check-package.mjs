import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'nl-lint-package-'))
const consumer = join(temporary, 'consumer')
const env = { ...process.env, TYPESAFE_API_KEY: '', TYPESAFE_MODEL: '', npm_config_cache: join(temporary, 'npm-cache') }
const run = (command, args, cwd = consumer) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const npm = (args, cwd) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], cwd)
  : run('npm', args, cwd)

try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', temporary], root))
  const expected = ['LICENSE', 'README.md', 'package.json', 'examples/nl-lint.config.mjs',
    'src/cache.mjs', 'src/cli.mjs', 'src/config.mjs', 'src/files.mjs', 'src/index.d.ts', 'src/index.mjs', 'src/init.mjs']
  assert.deepEqual(packed.files.map(file => file.path).sort(), expected.sort())
  // Exercise npx-style setup with no local dependency, using only a loopback registry.
  const fresh = join(temporary, 'fresh')
  await mkdir(fresh)
  await writeFile(join(fresh, 'package.json'), '{"name":"fresh-consumer","private":true}')
  const tarball = await readFile(join(temporary, packed.filename))
  const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const registry = createServer((request, response) => {
    if (request.url === '/nl-lint.tgz') return response.end(tarball)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ name: 'nl-lint', 'dist-tags': { latest: packageMetadata.version },
      versions: { [packageMetadata.version]: { ...packageMetadata,
        dist: { tarball: `http://127.0.0.1:${registry.address().port}/nl-lint.tgz`, integrity: packed.integrity } } } }))
  })
  await new Promise((resolve, reject) => { registry.once('error', reject); registry.listen(0, '127.0.0.1', resolve) })
  try {
    const args = ['exec', '--yes', '--package=nl-lint@latest', '--', 'nl-lint', 'init']
    const result = await promisify(execFile)(process.env.npm_execpath ? process.execPath : 'npm',
      process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args,
      { cwd: fresh, env: { ...env, npm_config_registry: `http://127.0.0.1:${registry.address().port}`,
        npm_config_audit: 'false', npm_config_fund: 'false', npm_config_fetch_retries: '0' } })
    assert.match(result.stdout, /Ready\./)
    const freshPackage = JSON.parse(await readFile(join(fresh, 'package.json'), 'utf8'))
    assert.ok(freshPackage.devDependencies['nl-lint'].includes(packageMetadata.version))
    assert.equal(freshPackage.scripts['lint:nl'], 'nl-lint src')
    assert.match(await readFile(join(fresh, 'nl-lint.config.mjs'), 'utf8'), /useful_comments/)
    assert.equal(await readFile(join(fresh, '.gitignore'), 'utf8'), '.cache/nl-lint/\n')
    assert.equal(JSON.parse(await readFile(join(fresh, 'node_modules/nl-lint/package.json'), 'utf8')).version, packageMetadata.version)
  } finally {
    await new Promise(resolve => registry.close(resolve))
  }
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'nl-lint-consumer', private: true, type: 'module' }))
  npm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(temporary, packed.filename)])
  const installed = join(consumer, 'node_modules/nl-lint')
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(metadata.license, 'MIT')
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0)
  assert.match(await readFile(join(installed, 'LICENSE'), 'utf8'), /MIT License/)
  assert.equal(run(process.execPath, [join(installed, metadata.bin['nl-lint']), '--version']).trim(), `nl-lint ${metadata.version}`)
  assert.match(npm(['exec', '--no', '--', 'nl-lint', '--help']), /Usage: nl-lint/)
  assert.match(npm(['exec', '--no', '--', 'nl-lint', 'init']), /Ready\./)
  const initializedPackage = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'))
  assert.equal(initializedPackage.scripts['lint:nl'], 'nl-lint src')
  assert.equal(await readFile(join(consumer, '.gitignore'), 'utf8'), '.cache/nl-lint/\n')
  await writeFile(join(consumer, 'consumer.mjs'), `
    import assert from 'node:assert/strict'
    import { lintSource, defaults, defaultCriteria } from 'nl-lint'
    import config from './nl-lint.config.mjs'
    assert.equal(defaults.threshold, 0.8)
    assert.equal(typeof defaultCriteria.pass, 'string')
    const report = await lintSource({ ...config, file: 'example.ts', source: 'export {}', cache: false,
      evaluate: async request => ({ model: request.model, answers: Object.fromEntries(Object.keys(request.questions).map(id =>
        [id, {type:'choice',choice:'pass',probabilities:{violation:0,pass:1,insufficient_context:0}}])) }) })
    assert.equal(report.passed, true)
  `)
  run(process.execPath, ['consumer.mjs'])
  await writeFile(join(consumer, 'example.ts'), 'export {}')
  await writeFile(join(consumer, 'offline.config.mjs'), `
    import config from './nl-lint.config.mjs'
    export default { ...config, cache: false, evaluate: async request => ({ model: request.model,
      answers: Object.fromEntries(Object.keys(request.questions).map(id =>
        [id, {type:'choice',choice:'pass',probabilities:{violation:0,pass:1,insufficient_context:0}}])) }) }
  `)
  const cliReport = JSON.parse(npm(['exec', '--no', '--', 'nl-lint', 'example.ts', '--config', 'offline.config.mjs', '--json']))
  assert.equal(cliReport.passed, true)
  assert.equal(cliReport.files[0].file, 'example.ts')
  await cp(join(root, 'test/types.mts'), join(consumer, 'types.mts'))
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.mts'])
  console.log(`Package verified: ${packed.entryCount} files, ${packed.size} compressed bytes. Installed API, CLI, types, example, and license passed.`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
