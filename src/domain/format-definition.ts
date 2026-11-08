import { Result, Schema } from 'effect'
import { SaveFormatVersion, ValidationMessage } from './brand-types.js'
import { validateFormatDefinition } from './format-validation.js'
import type { SaveFormat, SaveFormatMigration } from './format-types.js'

type SaveFormatMigrationSpec<A, I> = {
  readonly fromVersion: unknown
  readonly schema: Schema.Codec<A, I>
  readonly migrate: (value: A) => unknown
}

const isMigrationTransform = (value: unknown): value is SaveFormatMigration['migrate'] =>
  typeof value === 'function'

export const defineFormatMigration = <A, I>(
  spec: SaveFormatMigrationSpec<A, I>,
): Result.Result<SaveFormatMigration, ReadonlyArray<ValidationMessage>> => {
  const captured = Result.try({
    try: () => ({ fromVersion: spec.fromVersion, schema: spec.schema, migrate: spec.migrate }),
    catch: () => [ValidationMessage('format migration fields could not be read')],
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)

  if (typeof captured.success.fromVersion !== 'number') {
    return Result.fail([ValidationMessage('migration fromVersion must be a safe integer >= 1')])
  }
  const fromVersion = SaveFormatVersion.result(captured.success.fromVersion)
  if (Result.isFailure(fromVersion)) {
    return Result.fail([ValidationMessage('migration fromVersion must be a safe integer >= 1')])
  }
  if (typeof captured.success.migrate !== 'function') {
    return Result.fail([ValidationMessage('migration must provide a callable migrate function')])
  }

  const schema = captured.success.schema
  const migrate = captured.success.migrate
  return Result.succeed({
    fromVersion: fromVersion.success,
    migrate: (payload) => {
      const decoded = Result.try({
        try: () => Schema.decodeUnknownResult(schema)(payload),
        catch: (cause) => cause,
      })
      if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
      const schemaDecoded = decoded.success
      if (Result.isFailure(schemaDecoded)) return Result.fail(schemaDecoded.failure)
      return Result.try({
        try: () => migrate(schemaDecoded.success),
        catch: (cause) => cause,
      })
    },
  })
}

const normalizeMigrations = (
  value: unknown,
  currentVersion: number,
): Result.Result<ReadonlyArray<SaveFormatMigration> | undefined, ReadonlyArray<ValidationMessage>> => {
  if (value === undefined) return Result.succeed(undefined)

  const captured = Result.try({
    try: () => {
      if (!Array.isArray(value)) return undefined
      const items: Array<unknown> = []
      for (let index = 0; index < value.length; index += 1) {
        items.push(Reflect.get(value, String(index)))
      }
      return items
    },
    catch: () => [ValidationMessage('format migrations could not be read')],
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  if (captured.success === undefined) {
    return Result.fail([ValidationMessage('migrations must be an array')])
  }
  if (captured.success.length === 0) return Result.succeed(undefined)

  const migrations: Array<SaveFormatMigration> = []
  let previousVersion: number | undefined
  for (const item of captured.success) {
    if (typeof item !== 'object' || item === null) {
      return Result.fail([ValidationMessage('each migration must have a valid fromVersion and migrate function')])
    }
    const fields = Result.try({
      try: () => ({
        fromVersion: Reflect.get(item, 'fromVersion'),
        migrate: Reflect.get(item, 'migrate'),
      }),
      catch: () => [ValidationMessage('format migration fields could not be read')],
    })
    if (Result.isFailure(fields)) return Result.fail(fields.failure)
    const fromVersion = SaveFormatVersion.result(fields.success.fromVersion)
    if (Result.isFailure(fromVersion)) {
      return Result.fail([ValidationMessage('migration fromVersion must be a safe integer >= 1')])
    }
    if (!isMigrationTransform(fields.success.migrate)) {
      return Result.fail([ValidationMessage('each migration must provide a callable migrate function')])
    }
    if (fromVersion.success >= currentVersion) {
      return Result.fail([ValidationMessage('migration fromVersion must be less than the current format version')])
    }
    if (previousVersion !== undefined && fromVersion.success !== previousVersion + 1) {
      return Result.fail([ValidationMessage('migration versions must form an increasing contiguous chain')])
    }
    migrations.push({ fromVersion: fromVersion.success, migrate: fields.success.migrate })
    previousVersion = fromVersion.success
  }

  if (previousVersion !== currentVersion - 1) {
    return Result.fail([ValidationMessage('migration chain must end at the current format version')])
  }
  return Result.succeed(Object.freeze(migrations))
}

export const defineFormat = <A, I>(spec: {
  readonly name: unknown
  readonly version: unknown
  readonly schema: Schema.Codec<A, I>
  readonly migrations?: ReadonlyArray<SaveFormatMigration>
}): Result.Result<SaveFormat<A, I>, ReadonlyArray<ValidationMessage>> => {
  const captured = Result.try({
    try: () => ({ name: spec.name, version: spec.version, schema: spec.schema, migrations: spec.migrations }),
    catch: () => [ValidationMessage('format definition fields could not be read')],
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const identity = validateFormatDefinition(captured.success)
  if (Result.isFailure(identity)) return Result.fail(identity.failure)
  const migrations = normalizeMigrations(captured.success.migrations, identity.success.version)
  if (Result.isFailure(migrations)) return Result.fail(migrations.failure)
  return Result.succeed({
    ...identity.success,
    schema: captured.success.schema,
    ...(migrations.success === undefined ? {} : { migrations: migrations.success }),
  })
}
