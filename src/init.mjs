import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const cacheIgnore = '.cache/nl-lint/'
const scriptName = 'lint:nl'
const scriptValue = 'nl-lint src'

async function readPackage(path) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No package.json found. Run init from your project root.')
    throw error
  }
  try {
    const value = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return { source, value }
  } catch {
    throw new Error('package.json must contain a JSON object.')
  }
}

function hasDependency(pkg, name) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .some(field => Object.hasOwn(pkg[field] ?? {}, name))
}

async function installPackage(directory, name, version) {
  console.log(`Installing ${name}@${version} as a dev dependency...`)
  const args = ['install', '--save-dev', `${name}@${version}`]
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: directory, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: directory, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm install failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.status}`}.`)
}

function formatPackage(source, pkg) {
  const indent = source.match(/^[\t ]+(?=")/m)?.[0] ?? '  '
  return `${JSON.stringify(pkg, null, indent)}\n`
}

export async function initialize(directory = process.cwd()) {
  const packagePath = join(directory, 'package.json')
  let packageFile = await readPackage(packagePath)
  const ownPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  if (!hasDependency(packageFile.value, ownPackage.name)) {
    await installPackage(directory, ownPackage.name, ownPackage.version)
    packageFile = await readPackage(packagePath)
  } else {
    console.log(`${ownPackage.name} is already a project dependency.`)
  }

  const pkg = packageFile.value
  if (pkg.scripts === undefined) pkg.scripts = {}
  if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) {
    throw new Error('package.json scripts must be an object.')
  }
  if (Object.hasOwn(pkg.scripts, scriptName)) {
    console.log(`Kept existing scripts.${scriptName}: ${JSON.stringify(pkg.scripts[scriptName])}`)
  } else {
    pkg.scripts[scriptName] = scriptValue
    await writeFile(packagePath, formatPackage(packageFile.source, pkg))
    console.log(`Added scripts.${scriptName}.`)
  }

  const configPath = join(directory, 'nl-lint.config.mjs')
  try {
    const example = await readFile(new URL('../examples/nl-lint.config.mjs', import.meta.url), 'utf8')
    await writeFile(configPath, example, { flag: 'wx' })
    console.log('Created nl-lint.config.mjs.')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    console.log('Kept existing nl-lint.config.mjs.')
  }

  const ignorePath = join(directory, '.gitignore')
  let ignore = ''
  try {
    ignore = await readFile(ignorePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (ignore.split(/\r?\n/).some(line => line.trim() === cacheIgnore)) {
    console.log(`Kept existing ${cacheIgnore} ignore.`)
  } else {
    const newline = ignore.includes('\r\n') ? '\r\n' : '\n'
    const separator = ignore && !ignore.endsWith('\n') ? newline : ''
    await writeFile(ignorePath, `${ignore}${separator}${cacheIgnore}${newline}`)
    console.log(`Added ${cacheIgnore} to .gitignore.`)
  }

  console.log('Ready. Edit nl-lint.config.mjs, set TYPESAFE_API_KEY, then run npm run lint:nl.')
}
