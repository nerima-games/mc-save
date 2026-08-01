import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Schema } from 'effect'
import { saveEnvelope } from '../src/domain/envelope'
import { StorageError } from '../src/domain/errors'
import { defineFormat } from '../src/domain/format'
import { listFrom } from '../src/domain/persistence'
import { makeInMemoryStorage, SaveKey, StoragePort, type StorageService } from '../src/domain/storage-port'

const World = defineFormat({
  name: 'mc-save/test/world-listing',
  version: 1,
  schema: Schema.Struct({ name: Schema.String }),
  migrations: [],
})

const FIRST = SaveKey('world/first')
const BROKEN = SaveKey('world/broken')
const SECOND = SaveKey('world/second')
const FOREIGN = SaveKey('world/foreign')

describe('listFrom', () => {
  it.effect('isolates multiple corrupt records while preserving order in both partitions', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(FIRST, saveEnvelope(World.name, 1, { name: 'first' }))
      yield* storage.put(BROKEN, saveEnvelope(World.name, 1, { name: 42 }))
      yield* storage.put(SECOND, saveEnvelope(World.name, 1, { name: 'second' }))
      yield* storage.put(FOREIGN, saveEnvelope('another-format', 1, { name: 'foreign' }))

      const listed = yield* listFrom(World)

      expect(listed.valid).toStrictEqual([
        { key: FIRST, value: { name: 'first' } },
        { key: SECOND, value: { name: 'second' } },
      ])
      expect(listed.corrupt.map(({ key }) => key)).toStrictEqual([BROKEN, FOREIGN])
      expect(listed.corrupt[0]).toMatchObject({
        _tag: 'SaveDecodeError',
        key: BROKEN,
        format: World.name,
        version: 1,
        reason: 'the payload does not satisfy the current schema',
      })
      expect(listed.corrupt[1]?.reason).toContain('another-format')
      expect(listed.corrupt.every((failure) => !('cause' in failure))).toBe(true)
      expect(JSON.stringify(listed.corrupt)).not.toContain('42')
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  it.effect('fails the whole listing when reading the storage medium fails', () => {
    const service: StorageService = {
      keys: Effect.succeed([FIRST, SECOND]),
      get: (key) =>
        key === FIRST
          ? Effect.succeed(Option.some(saveEnvelope(World.name, 1, { name: 'first' })))
          : Effect.fail(new StorageError({ operation: 'test.get', key })),
      put: () => Effect.void,
      remove: () => Effect.void,
    }

    return Effect.gen(function* () {
      const error = yield* Effect.flip(listFrom(World))
      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('test.get')
      expect(error.key).toBe(SECOND)
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })

  it.effect('isolates a migration failure without exposing its cause', () => {
    const MigratingWorld = defineFormat({
      name: World.name,
      version: 2,
      schema: World.schema,
      migrations: [
        {
          from: 1,
          describe: 'reject an unusable legacy record',
          migrate: () => Effect.fail('legacy payload is unusable'),
        },
      ],
    })

    return Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(BROKEN, saveEnvelope(World.name, 1, { secret: 'do not disclose' }))

      const listed = yield* listFrom(MigratingWorld)

      expect(listed.valid).toStrictEqual([])
      expect(listed.corrupt).toStrictEqual([
        {
          _tag: 'MigrationError',
          key: BROKEN,
          format: World.name,
          fromVersion: 1,
          toVersion: 2,
          reason: 'reject an unusable legacy record — legacy payload is unusable',
        },
      ])
      expect(JSON.stringify(listed)).not.toContain('do not disclose')
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage)))
  })

  it.effect('fails without reading records when key enumeration fails', () => {
    const failure = new StorageError({ operation: 'test.keys' })
    const service: StorageService = {
      keys: Effect.fail(failure),
      get: () => Effect.die('must not read a key after listing failed'),
      put: () => Effect.void,
      remove: () => Effect.void,
    }

    return Effect.gen(function* () {
      expect(yield* Effect.flip(listFrom(World))).toBe(failure)
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })
})
