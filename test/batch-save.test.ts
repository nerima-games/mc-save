import { describe, expect } from 'vitest'
import { Effect, Option, Schema } from 'effect'
import { effect } from './support/effect-test.js'
import { defineFormat } from '../src/domain/format.js'
import { loadFrom } from '../src/domain/persistence.js'
import { saveBatch, saveBatchEntry } from '../src/domain/batch-save.js'
import { InMemoryStorageLayer, SaveKey, StoragePort, failingStorageLayer } from '../src/domain/storage-port.js'

const World = defineFormat({
  name: 'mc-save/test/batch-world',
  version: 1,
  schema: Schema.Struct({ seed: Schema.Number, name: Schema.String }),
})

const Settings = defineFormat({
  name: 'mc-save/test/batch-settings',
  version: 1,
  schema: Schema.Struct({ difficulty: Schema.Literal('peaceful', 'normal', 'hard') }),
})

const WORLD_KEY = SaveKey('world/overworld')
const SETTINGS_KEY = SaveKey('world/overworld/settings')

// Widens a value's static type to `T` with NO runtime transformation and no type assertion:
// `Record<string, any>` indexing is `any` by construction, assignable anywhere with zero compiler
// complaint. Used to hand a schema-invalid literal to a schema-typed parameter, so the test proves
// runtime schema validation — not the type checker — rejects it.
const widen = <T,>(value: unknown): T => {
  const bag: Record<string, any> = {}
  bag['value'] = value
  return bag['value']
}

describe('saveBatch', () => {
  effect('encodes typed entries and commits them together', () =>
    Effect.gen(function* () {
      yield* saveBatch([
        saveBatchEntry(World, WORLD_KEY, { seed: 42, name: 'overworld' }),
        saveBatchEntry(Settings, SETTINGS_KEY, { difficulty: 'hard' as const }, { extensions: { source: 'test' } }),
      ])

      const world = yield* loadFrom(World, WORLD_KEY)
      const settings = yield* loadFrom(Settings, SETTINGS_KEY)
      expect(world).toStrictEqual(Option.some({ seed: 42, name: 'overworld' }))
      expect(settings).toStrictEqual(Option.some({ difficulty: 'hard' }))

      const storage = yield* StoragePort
      const stored = yield* storage.get(SETTINGS_KEY)
      expect(Option.isSome(stored) && stored.value.extensions).toStrictEqual({ source: 'test' })
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('prepares every entry before changing the store', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        saveBatch([
          saveBatchEntry(World, WORLD_KEY, { seed: 42, name: 'overworld' }),
          saveBatchEntry(Settings, SETTINGS_KEY, { difficulty: widen<'hard'>('invalid') }),
        ]),
      )

      if (error._tag !== 'SaveDecodeError') throw error
      expect(error._tag).toBe('SaveDecodeError')
      const storage = yield* StoragePort
      expect(yield* storage.get(WORLD_KEY)).toStrictEqual(Option.none())
      expect(yield* storage.get(SETTINGS_KEY)).toStrictEqual(Option.none())
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('does not require a storage service for an empty batch', () =>
    saveBatch([]).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('returns the adapter failure after preparing the batch', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(saveBatch([saveBatchEntry(World, WORLD_KEY, { seed: 42, name: 'overworld' })]))
      if (error._tag !== 'StorageError') throw error
      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('unavailable')
    }).pipe(Effect.provide(failingStorageLayer('unavailable'))),
  )
})
