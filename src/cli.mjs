#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectFiles } from './files.mjs'
import { prepareConfig } from './config.mjs'
import { lintSource } from './index.mjs'
import { initialize } from './init.mjs'

async function findConfig(explicit) {
  let directory = process.cwd()
  while (true) {
    const path = explicit ? resolve(explicit) : resolve(directory, 'nl-lint.config.mjs')
    try {
      await access(path)
      return path
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (explicit) throw new Error(`Config not found: ${path}. Create it or use --config with an existing file.`)
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('No nl-lint.config.mjs found. Create one with npx nl-lint@latest init or select a file with --config path.')
    directory = parent
  }
}

const needsReview = result => !result.failed && result.choice !== 'pass'

const symbols = { pass: '✓', review: '◇', fail: '✗' }
const colors = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' }

function paint(value, color, enabled) {
  return enabled ? `${colors[color]}${value}${colors.reset}` : value
}

function resultKind(result) {
  return result.failed ? 'fail' : result.choice === 'pass' ? 'pass' : 'review'
}

async function main() {
  const args = process.argv.slice(2)
  if (!args.length || args.includes('--help')) {
    console.log('Usage: nl-lint init | <file/folder> [...] | --diff[=ref]\nOptions: --config path (otherwise nearest ancestor nl-lint.config.mjs), --json, --verbose, --refresh, --no-cache, --version\ninit installs and configures nl-lint in the current project using its package manager.\nCLI selects JS/TS source. Folder scans and --diff require Git.\nExit: 0 threshold passed (may need review), 1 rule failure, 2 operational/config error.\nUncached source files are sent to TypeSafe. Set TYPESAFE_API_KEY.')
    return
  }
  if (args.length === 1 && args[0] === '--version') {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(`nl-lint ${version}`)
    return
  }
  if (args[0] === 'init') {
    if (args.length !== 1) throw new Error('init takes no arguments.')
    await initialize()
    return
  }
  let configPath
  const files = [], flags = new Set()
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config requires a path.')
      configPath = args[++i]
    } else if (['--json', '--verbose', '--refresh', '--no-cache'].includes(args[i])) flags.add(args[i])
    else if (args[i].startsWith('-') && args[i] !== '--diff' && !args[i].startsWith('--diff=')) throw new Error(`Unknown option ${args[i]}. See --help.`)
    else files.push(args[i])
  }
  if (!files.length) throw new Error('Provide files, folders or --diff.')
  const { default: config } = await import(pathToFileURL(await findConfig(configPath)).href)
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config must export a default object.')
  const options = { ...config,
    refresh: flags.has('--refresh') ? true : config.refresh,
    cache: flags.has('--no-cache') ? false : config.cache }
  prepareConfig(options)
  const reports = []
  const selected = await collectFiles(files)
  const useColor = Boolean(process.stdout.isTTY)
  for (const [index, file] of selected.entries()) {
    if (!flags.has('--json') && (process.stderr.isTTY || flags.has('--verbose'))) {
      console.error(paint(`  ${symbols.review} Checking ${index + 1}/${selected.length}: ${file}`, 'dim', process.stderr.isTTY))
    }
    reports.push(await lintSource({ ...options, file, source: await readFile(file, 'utf8') }))
  }
  const passed = reports.every(r => r.passed)
  if (flags.has('--json')) console.log(JSON.stringify({ passed, files: reports }, null, 2))
  else {
    for (const report of reports) {
      const status = !report.passed ? 'FAIL' : report.results.some(needsReview) ? 'REVIEW' : 'PASS'
      const kind = status === 'FAIL' ? 'fail' : status === 'PASS' ? 'pass' : 'review'
      console.log(`${paint(status, kind === 'fail' ? 'red' : kind === 'pass' ? 'green' : 'yellow', useColor)} ${report.file}${report.cached ? paint(' (cached)', 'dim', useColor) : ''}`)
      if (flags.has('--verbose')) console.log('')
      for (const r of report.results) {
        if (flags.has('--verbose') || r.failed || r.choice !== 'pass') {
          const resultStatus = r.failed ? 'FAIL' : r.choice === 'pass' ? 'PASS' : 'REVIEW'
          const resultColor = resultKind(r) === 'fail' ? 'red' : resultKind(r) === 'pass' ? 'green' : 'yellow'
          console.log(`  ${paint(symbols[resultKind(r)], resultColor, useColor)} ${paint(resultStatus, resultColor, useColor)}  ${r.title}`)
          const question = Array.isArray(r.question) ? r.question.join(' ') : r.question
          console.log(`    question: ${question}`)
          console.log(`    choice: ${r.choice}  ·  P(violation): ${r.probabilities.violation}  ·  threshold: ${r.threshold}`)
          if (r.failed) console.log(`    ${r.message}`)
          if (flags.has('--verbose')) console.log(`    probabilities: ${JSON.stringify(r.probabilities)}`)
        }
      }
      if (flags.has('--verbose')) console.log('')
    }
    const results = reports.flatMap(report => report.results)
    console.log(`${reports.length} ${reports.length === 1 ? 'file' : 'files'}; ${results.filter(r => r.failed).length} rule failures; ${results.filter(needsReview).length} need review; ${passed ? 'passed' : 'failed'} thresholds.`)
  }
  process.exitCode = passed ? 0 : 1
}
main().catch(error => { console.error(`nl-lint: ${error.message}`); process.exitCode = 2 })
