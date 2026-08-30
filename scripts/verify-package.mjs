import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const rootDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(rootDirectory)
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

const run = async (command, arguments_, cwd) => {
  try {
    const result = await execFileAsync(command, arguments_, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    })
    return result.stdout
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout) : ''
    const output = [stderr, stdout].filter((value) => value.length > 0).join('\n')
    throw new Error(`${command} ${arguments_.join(' ')} failed: ${details}${output.length === 0 ? '' : `\n${output}`}`, {
      cause: error,
    })
  }
}

const verifyArchiveContents = async (archivePath) => {
  const entries = (await run('tar', ['-tzf', archivePath], packageRoot)).split(/\r?\n/u).filter(Boolean)
  const entrySet = new Set(entries)
  const requiredEntries = ['package/dist/index.js', 'package/dist/index.d.ts', 'package/README.md']
  const missingEntries = requiredEntries.filter((entry) => !entrySet.has(entry))

  if (missingEntries.length > 0) {
    throw new Error(`published archive is missing: ${missingEntries.join(', ')}`)
  }
  if (entries.some((entry) => entry.startsWith('package/src/'))) {
    throw new Error('published archive must not contain source files')
  }
}

const verifyRuntimeImport = async (consumerDirectory, packageName) => {
  const packageLiteral = JSON.stringify(packageName)
  const runtimeProbe = `
import { Effect, Option, Schedule, Schema } from 'effect'
import * as packageModule from ${packageLiteral}

const functionExports = ['defineFormat', 'encodeSave', 'decodeSave', 'saveTo', 'loadFrom', 'withStorageRetry']
for (const exportName of functionExports) {
  if (typeof packageModule[exportName] !== 'function') {
    throw new Error(\`missing runtime export: \${exportName}\`)
  }
}
if (typeof packageModule.makeInMemoryStorage !== 'object' || packageModule.makeInMemoryStorage === null) {
  throw new Error('missing runtime export: makeInMemoryStorage')
}

const format = packageModule.defineFormat({
  name: 'package-verify',
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
})
const envelope = await Effect.runPromise(packageModule.encodeSave(format, { value: 'ok' }))
const decoded = await Effect.runPromise(packageModule.decodeSave(format, envelope))
if (decoded.value !== 'ok') {
  throw new Error('root import did not decode an encoded value')
}

const storage = await Effect.runPromise(packageModule.makeInMemoryStorage)
const key = packageModule.SaveKey('package-verify')
await Effect.runPromise(storage.put(key, envelope))
const stored = await Effect.runPromise(storage.get(key))
if (!Option.isSome(stored) || stored.value.payload.value !== 'ok') {
  throw new Error('root import did not expose a working storage adapter')
}
const retryingStorage = packageModule.withStorageRetry(storage, {
  schedule: Schedule.recurs(0),
  shouldRetry: () => true,
})
const retryStored = await Effect.runPromise(retryingStorage.get(key))
if (!Option.isSome(retryStored) || retryStored.value.payload.value !== 'ok') {
  throw new Error('root import did not expose a working retry decorator')
}
`
  const probePath = join(consumerDirectory, 'runtime-probe.mjs')
  await writeFile(probePath, runtimeProbe)
  await run(process.execPath, [probePath], consumerDirectory)
}

const verifyTypeImport = async (consumerDirectory, packageName) => {
  const packageLiteral = JSON.stringify(packageName)
  const typeProbe = `
import { Schedule, Schema } from 'effect'
import { defineFormat, type SaveFormat, type StorageRetryPolicy } from ${packageLiteral}

const format: SaveFormat<string, string> = defineFormat({
  name: 'package-type-verify',
  version: 1,
  schema: Schema.String,
})
void format
const retryPolicy: StorageRetryPolicy = { schedule: Schedule.recurs(1), shouldRetry: () => true }
void retryPolicy
`
  const probePath = join(consumerDirectory, 'type-probe.ts')
  const configPath = join(consumerDirectory, 'tsconfig.json')
  await writeFile(probePath, typeProbe)
  await writeFile(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['type-probe.ts'],
      },
      null,
      2,
    ),
  )
  const compilerPath = [
    join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc6'),
  ].find((candidate) => existsSync(candidate))
  if (compilerPath === undefined) {
    throw new Error('could not find the installed TypeScript compiler')
  }
  await run(process.execPath, [compilerPath, '--project', configPath, '--pretty', 'false'], consumerDirectory)
}

const verifyPackage = async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error('package.json must declare a package name')
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mc-save-package-'))
  try {
    await run('pnpm', ['pack', '--pack-destination', temporaryDirectory], packageRoot)
    const archives = (await readdir(temporaryDirectory)).filter((entry) => entry.endsWith('.tgz'))
    if (archives.length !== 1) {
      throw new Error(`expected one packed archive, found ${String(archives.length)}`)
    }

    const archivePath = join(temporaryDirectory, archives[0])
    await verifyArchiveContents(archivePath)

    const consumerDirectory = join(temporaryDirectory, 'consumer')
    await mkdir(consumerDirectory)
    await writeFile(
      join(consumerDirectory, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }, null, 2),
    )
    const packageScope = manifest.name.startsWith('@') ? manifest.name.slice(0, manifest.name.indexOf('/')) : undefined
    const publishRegistry = manifest.publishConfig?.registry
    const installArguments = ['install', '--ignore-scripts', '--no-audit', '--no-fund']
    if (packageScope !== undefined && typeof publishRegistry === 'string') {
      installArguments.push(`--${packageScope}:registry=${publishRegistry}`)
    }
    installArguments.push(archivePath)
    await run('npm', installArguments, consumerDirectory)
    await Promise.all([
      verifyRuntimeImport(consumerDirectory, manifest.name),
      verifyTypeImport(consumerDirectory, manifest.name),
    ])
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

try {
  await verifyPackage()
  process.stdout.write('package verification passed\n')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
