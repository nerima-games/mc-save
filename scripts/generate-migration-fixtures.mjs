import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageName = '@nerima-games/mc-save'
const packageVersion = '0.5.0'
const registry = 'https://npm.pkg.github.com'
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')

const cases = (Schema) => {
  const formatName = 'mc-save/test/migration/chunk'

  return [
    {
      version: 1,
      schema: Schema.Struct({
        worldId: Schema.String,
        blocks: Schema.Uint8Array,
        inventory: Schema.Array(Schema.NullOr(Schema.String)),
      }),
      value: {
        worldId: 'overworld-alpha',
        blocks: new Uint8Array([0, 1, 2, 255, 7, 0]),
        inventory: ['diamond_pickaxe', null, null, 'torch'],
      },
    },
    {
      version: 2,
      schema: Schema.Struct({
        worldId: Schema.String,
        blocks: Schema.Array(
          Schema.Number.pipe(Schema.int(), Schema.between(0, 65_535)),
        ),
        inventory: Schema.Array(Schema.NullOr(Schema.String)),
      }),
      value: {
        worldId: 'overworld-beta',
        blocks: [0, 300, 65_535],
        inventory: ['iron_pickaxe', null],
      },
    },
  ].map((entry) => ({ ...entry, name: formatName }))
}

if (!process.env.NODE_AUTH_TOKEN) {
  throw new Error('Set NODE_AUTH_TOKEN to a GitHub Packages read token before generating fixtures.')
}

const installDirectory = await mkdtemp(join(tmpdir(), 'mc-save-v0.5.0-fixtures-'))
try {
  await writeFile(join(installDirectory, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { [packageName]: packageVersion },
  }))
  await writeFile(
    join(installDirectory, '.npmrc'),
    `@nerima-games:registry=${registry}\n//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n`,
  )
  await execFileAsync('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--userconfig',
    join(installDirectory, '.npmrc'),
    '--prefix',
    installDirectory,
  ], { cwd: installDirectory, env: process.env })

  const requireFromInstall = createRequire(join(installDirectory, 'package.json'))
  const encoder = await import(pathToFileURL(requireFromInstall.resolve(packageName)).href)
  const { Effect, Schema } = await import(pathToFileURL(requireFromInstall.resolve('effect')).href)
  const { stdout: integrityJson } = await execFileAsync('npm', [
    'view',
    `${packageName}@${packageVersion}`,
    'dist.integrity',
    '--json',
    '--userconfig',
    join(installDirectory, '.npmrc'),
  ], { cwd: installDirectory, env: process.env })
  const packageIntegrity = JSON.parse(integrityJson)
  if (typeof packageIntegrity !== 'string' || !packageIntegrity.startsWith('sha512-')) {
    throw new Error('The published package integrity metadata is missing.')
  }

  const fixtures = await Promise.all(cases(Schema).map(async (entry) => {
    const format = encoder.defineFormat({
      name: entry.name,
      version: entry.version,
      schema: entry.schema,
    })
    const draft = await Effect.runPromise(encoder.encodeSave(format, entry.value))
    const envelope = encoder.sealSaveEnvelope(draft)
    const json = JSON.stringify(envelope)
    const fixture = {
      encoder: {
        package: packageName,
        version: packageVersion,
        integrity: packageIntegrity,
      },
      format: { name: entry.name, version: entry.version },
      json,
      bytesBase64: Buffer.from(json, 'utf8').toString('base64'),
    }
    return {
      path: join(fixtureDirectory, `migration-v${entry.version}-mc-save-0.5.0.json`),
      content: `${JSON.stringify(fixture, null, 2)}\n`,
    }
  }))
  await Promise.all(fixtures.map(({ path, content }) => writeFile(path, content)))
} finally {
  await rm(installDirectory, { recursive: true, force: true })
}
