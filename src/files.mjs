import { execFileSync } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx)$/
const excluded =
  /(?:^|\/)(?:node_modules|\.git|\.next|\.yarn|\.turbo|dist|build|coverage)(?:\/|$)|\.d\.[cm]?ts$/

function git(args, cwd = process.cwd()) {
  try {
    return execFileSync('git', ['--literal-pathspecs', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Git is required for folders and --diff. Install Git or pass individual source files.')
    if (args.includes('--show-toplevel')) throw new Error('Could not find a Git repository. Run inside a repository or pass individual source files.')
    if (args.includes('--verify')) throw new Error(`Invalid Git reference ${JSON.stringify(args.at(-1).replace(/\^\{commit\}$/, ''))}. Fetch the ref or create an initial commit.`)
    throw new Error(`Git failed: ${error.stderr?.toString().trim() || error.message}`)
  }
}

export async function collectFiles(args) {
  const diff = args.find((arg) => arg === '--diff' || arg.startsWith('--diff='))
  if (args.some((arg) => arg.startsWith('-') && arg !== diff) || (diff && args.length !== 1)) {
    throw new Error('Use files/folders or --diff[=ref], not both. See --help.')
  }

  const candidates = []
  if (diff) {
    const ref = diff === '--diff' ? 'HEAD' : diff.slice('--diff='.length)
    if (!ref || ref.startsWith('-')) throw new Error('Invalid Git reference.')
    const root = git(['rev-parse', '--show-toplevel']).trim()
    const revision = git(
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      root,
    ).trim()
    candidates.push(
      ...git(['diff', '--name-only', '-z', '--diff-filter=ACMR', revision, '--'], root)
        .split('\0')
        .filter(Boolean)
        .map((file) => resolve(root, file)),
    )
  } else {
    for (const arg of args) {
      const path = resolve(arg)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new Error(`Cannot lint ${JSON.stringify(arg)}: symbolic links are not supported.`)
      if (stat.isDirectory()) {
        const root = git(['rev-parse', '--show-toplevel'], path).trim()
        const pathspec = relative(root, path) || '.'
        if (isAbsolute(pathspec) || pathspec.startsWith(`..${sep}`)) {
          throw new Error('The folder must be inside the Git repository.')
        }
        candidates.push(
          ...git(
            ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', pathspec],
            root,
          )
            .split('\0')
            .filter(Boolean)
            .map((file) => resolve(root, file)),
        )
      } else {
        if (!stat.isFile() || !sourceFile.test(path)) {
          throw new Error(`Unsupported file ${JSON.stringify(arg)}. CLI accepts regular JavaScript/TypeScript source files.`)
        }
        if (excluded.test(path)) {
          throw new Error(`Cannot lint ${JSON.stringify(arg)}: declarations and build/dependency files are excluded.`)
        }
        candidates.push(path)
      }
    }
  }

  const files = []
  for (const file of [...new Set(candidates)].sort()) {
    if (!sourceFile.test(file) || excluded.test(file)) continue
    try {
      if ((await lstat(file)).isFile()) files.push(relative(process.cwd(), file))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return files
}
