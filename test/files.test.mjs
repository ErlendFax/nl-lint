import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectFiles } from '../src/files.mjs'

test('folders and Git diffs select source files without duplicates or deleted files', async () => {
  const originalCwd = process.cwd()
  const root = await mkdtemp(join(tmpdir(), 'semantic-lint-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  try {
    git('init')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    await mkdir(join(root, 'src/(side)'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    for (const file of ['staged.ts', 'unstaged.ts', 'deleted.ts', 'old.ts', '(side)/kort.tsx']) {
      await writeFile(join(root, 'src', file), 'export const value = 1\n')
    }
    git('add', '.')
    git('commit', '-m', 'Initial')
    await writeFile(join(root, 'src/staged.ts'), 'export const value = 2\n')
    await writeFile(join(root, 'src/new.ts'), 'export const added = true\n')
    await rename(join(root, 'src/old.ts'), join(root, 'src/renamed.ts'))
    git('add', 'src')
    await writeFile(join(root, 'src/unstaged.ts'), 'export const value = 3\n')
    await rm(join(root, 'src/deleted.ts'))
    await writeFile(join(root, 'src/untracked.tsx'), 'export const untracked = true\n')
    await writeFile(join(root, 'src/types.d.ts'), 'export type Value = string\n')
    await writeFile(join(root, 'src/readme.md'), 'Dokumentasjon')
    for (const dir of ['ignored', 'node_modules', 'dist']) {
      await mkdir(join(root, dir))
      await writeFile(join(root, dir, 'skip.ts'), 'export {}')
    }

    process.chdir(root)
    assert.deepEqual(await collectFiles(['.', 'src', 'src/(side)/kort.tsx']), [
      'src/(side)/kort.tsx',
      'src/new.ts',
      'src/renamed.ts',
      'src/staged.ts',
      'src/unstaged.ts',
      'src/untracked.tsx',
    ])
    const changed = ['src/new.ts', 'src/renamed.ts', 'src/staged.ts', 'src/unstaged.ts']
    assert.deepEqual(await collectFiles(['--diff']), changed)
    assert.deepEqual(await collectFiles(['--diff=HEAD']), changed)
    process.chdir(join(root, 'src'))
    assert.deepEqual(
      await collectFiles(['--diff']),
      changed.map((file) => file.slice(4)),
    )
    await assert.rejects(collectFiles(['--diff', '.']), /not both/)
    await assert.rejects(collectFiles(['--diff=']), /Invalid/)
    git('add', 'src')
    git('commit', '-m', 'Changes')
    assert.deepEqual(await collectFiles(['--diff']), [])
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})
