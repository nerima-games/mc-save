import { describe, expect } from 'vitest'
import { Effect } from 'effect'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { effect } from './support/effect-test.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const compiler = [
  path.join(repositoryRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc'),
  path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc6'),
].find((candidate) => existsSync(candidate))

if (compiler === undefined) {
  throw new Error('No TypeScript compiler binary is installed for the IndexedDB surface test')
}

describe('the IndexedDB surface is a real subset of the real DOM', () => {
  effect(
    'a real IDBFactory, IDBDatabase and IDBRequest satisfy the adapter without a cast',
    () =>
      Effect.sync(() => {
        const fixture = path.join(repositoryRoot, 'test', 'fixtures', 'indexeddb-surface.ts')
        execFileSync(
          process.execPath,
          [
            compiler,
            '--ignoreConfig',
            '--noEmit',
            '--strict',
            '--exactOptionalPropertyTypes',
            '--noUncheckedIndexedAccess',
            '--target',
            'ES2022',
            '--module',
            'ESNext',
            '--moduleResolution',
            'Bundler',
            '--moduleDetection',
            'Force',
            '--skipLibCheck',
            '--types',
            '',
            '--lib',
            'ES2022,DOM',
            fixture,
          ],
          { cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe' },
        )
      }),
    30_000,
  )

  effect('the shipped project still compiles with no DOM at all', () =>
    Effect.sync(() => {
      const output = execFileSync(
        process.execPath,
        [compiler, '--showConfig', '-p', path.join(repositoryRoot, 'tsconfig.build.json')],
        { cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe' },
      )
      expect(output).not.toBe('')
      // `JSON.parse` returns `any`, which is assignable to this annotation with
      // no cast — `any` bypasses type checking on the RHS, not the LHS binding.
      const parsed: {
        compilerOptions?: { lib?: string[]; types?: string[] }
        files?: string[]
      } = JSON.parse(output)

      expect(parsed.compilerOptions?.lib).toStrictEqual(['es2024'])
      expect(parsed.compilerOptions?.types).toStrictEqual([])
      expect(parsed.files?.some((file) => file.endsWith('domain/indexeddb-storage.ts'))).toBe(true)
      expect(parsed.files?.some((file) => file.includes('/test/fixtures/'))).toBe(false)
    }),
  )
})
