import { spawnSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

async function packageManager(directory) {
  const lockfiles = { npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'], bun: ['bun.lock', 'bun.lockb'] }
  while (true) {
    let pkg = {}
    try { pkg = (await readPackage(join(directory, 'package.json'))).value } catch (error) {
      if (!error.message.startsWith('No package.json found.')) throw error
    }
    if (pkg.packageManager !== undefined) {
      const manager = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
      if (!Object.hasOwn(lockfiles, manager)) throw new Error('Unsupported packageManager. Use npm, pnpm, yarn, or bun.')
      return manager
    }
    const found = []
    for (const [manager, files] of Object.entries(lockfiles)) {
      for (const file of files) {
        try { await access(join(directory, file)); found.push(manager); break } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    }
    if (found.length > 1) throw new Error('Multiple package-manager lockfiles found. Set packageManager in package.json before running init.')
    if (found.length === 1) return found[0]
    const parent = dirname(directory)
    if (parent === directory) return 'npm'
    directory = parent
  }
}

async function installPackage(directory, name, version, manager) {
  console.log(`Installing ${name}@${version} as a dev dependency...`)
  const args = [manager === 'npm' ? 'install' : 'add', manager === 'npm' ? '--save-dev' : '-D', `${name}@${version}`]
  const launcher = process.env.npm_config_user_agent?.split('/')[0] ?? 'npm'
  const executable = process.env.npm_execpath && launcher === manager ? process.env.npm_execpath : manager
  const result = /\.[cm]?js$/.test(executable)
    ? spawnSync(process.execPath, [executable, ...args], { cwd: directory, stdio: 'inherit' })
    : spawnSync(executable, args, { cwd: directory, stdio: 'inherit' })
  if (result.error) throw new Error(`Could not run ${manager}: ${result.error.message}. Install the project's package manager and retry init.`)
  if (result.status !== 0) throw new Error(`${manager} ${args[0]} failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.status}`}.`)
}

function formatPackage(source, pkg) {
  const indent = source.match(/^[\t ]+(?=")/m)?.[0] ?? '  '
  return `${JSON.stringify(pkg, null, indent)}\n`
}

export async function initialize(directory = process.cwd()) {
  const packagePath = join(directory, 'package.json')
  let packageFile = await readPackage(packagePath)
  const ownPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const manager = await packageManager(directory)

  if (packageFile.value.scripts !== undefined && (!packageFile.value.scripts || typeof packageFile.value.scripts !== 'object' || Array.isArray(packageFile.value.scripts))) {
    throw new Error('package.json scripts must be an object.')
  }

  if (!hasDependency(packageFile.value, ownPackage.name)) {
    await installPackage(directory, ownPackage.name, ownPackage.version, manager)
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

  console.log(`Ready. Edit nl-lint.config.mjs, set TYPESAFE_API_KEY, then run ${manager} run lint:nl.`)
}
