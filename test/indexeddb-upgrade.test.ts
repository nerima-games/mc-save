import { describe, expect } from 'vitest'
import { Effect, Option, Schema } from 'effect'
import { effect } from './support/effect-test.js'
import { defineFormat } from '../src/domain/format.js'
import {
  INSERTION_INDEX_NAME,
  indexedDbStorageLayer,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
} from '../src/domain/indexeddb-storage.js'
import { loadFrom, saveTo } from '../src/domain/persistence.js'
import { SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { makeFakeIndexedDb } from './fake-indexeddb.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

const DATABASE = 'mc-save/test/worlds'
const A = SaveKey('alpha')
const B = SaveKey('beta')
const envelope = (payload: unknown) => sealedTestEnvelope('mc-save/test/idb', 1, payload)

const layerFor = (factory: ReturnType<typeof makeFakeIndexedDb>, databaseName = DATABASE) =>
  indexedDbStorageLayer({ factory, databaseName })

describe('onupgradeneeded and a database written by an older version', () => {
  effect('creates the store and index on a database that has never been opened', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        yield* StoragePort
      }).pipe(Effect.provide(layerFor(factory)))

      expect(factory.storeNamesOf(DATABASE)).toStrictEqual([SAVE_STORE_NAME])
      expect(factory.indexNamesOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([INSERTION_INDEX_NAME])
    }),
  )

  effect('an older database keeps every record it had — nothing is rewritten', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, 0, SAVE_STORE_NAME, [
        { key: 'alpha', seq: 0, envelope: envelope({ n: 1 }) },
        { key: 'beta', seq: 1, envelope: envelope({ n: 2 }) },
      ])

      const found = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return {
          keys: yield* storage.keys,
          alpha: yield* storage.get(A),
          batch: yield* storage.readBatch([A, B]),
        }
      }).pipe(Effect.provide(layerFor(factory)))

      expect(found.keys).toStrictEqual([A, B])
      expect(found.alpha).toStrictEqual(Option.some(envelope({ n: 1 })))
      expect(found.batch).toStrictEqual([
        Option.some(envelope({ n: 1 })),
        Option.some(envelope({ n: 2 })),
      ])
    }),
  )

  effect('repairs an existing store that lacks the insertion index', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seedWithoutIndexes(DATABASE, STORE_LAYOUT_VERSION - 1, SAVE_STORE_NAME, [
        { key: 'alpha', seq: 0, envelope: envelope({ n: 1 }) },
        { key: 'beta', seq: 1, envelope: envelope({ n: 2 }) },
      ])

      const found = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        const before = yield* storage.keys
        yield* storage.put(SaveKey('gamma'), envelope({ n: 3 }))
        const after = yield* storage.keys
        return { before, after }
      }).pipe(Effect.provide(layerFor(factory)))

      expect(found.before).toStrictEqual([A, B])
      expect(found.after).toStrictEqual([A, B, 'gamma'])
      expect(factory.indexNamesOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([INSERTION_INDEX_NAME])
      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: envelope({ n: 1 }) },
        { key: 'beta', seq: 1, envelope: envelope({ n: 2 }) },
        { key: 'gamma', seq: 2, envelope: envelope({ n: 3 }) },
      ])
    }),
  )

  effect('a new key written after an upgrade continues the old sequence', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, 0, SAVE_STORE_NAME, [
        { key: 'zulu', seq: 7, envelope: envelope({}) },
      ])

      const keys = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(SaveKey('alpha'), envelope({}))
        return yield* storage.keys
      }).pipe(Effect.provide(layerFor(factory)))

      expect(keys).toStrictEqual(['zulu', 'alpha'])
    }),
  )

  effect('the layout version and the save-format version are different numbers', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      const AtVersionThree = defineFormat({
        name: 'mc-save/test/idb-versioned',
        version: 3,
        schema: Schema.Struct({ n: Schema.Number }),
      })

      yield* saveTo(AtVersionThree, A, { n: 1 }).pipe(Effect.provide(layerFor(factory)))

      const listed = (yield* Effect.promise(() => factory.databases?.() ?? Promise.resolve([]))) ?? []
      expect(listed).toStrictEqual([{ name: DATABASE, version: STORE_LAYOUT_VERSION }])
      const expectedEnvelope = sealedTestEnvelope('mc-save/test/idb-versioned', 3, { n: 1 })
      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: expectedEnvelope },
      ])
    }),
  )
})

describe('a save crosses the real seam', () => {
  effect('saveTo then loadFrom round-trips through a database', () =>
    Effect.gen(function* () {
      const Chunk = defineFormat({
        name: 'mc-save/test/idb-chunk',
        version: 1,
        schema: Schema.Struct({ blocks: Schema.Uint8Array }),
      })

      yield* saveTo(Chunk, A, { blocks: new Uint8Array([1, 2, 3, 4]) })
      const loaded = yield* loadFrom(Chunk, A)

      expect(Option.isSome(loaded)).toBe(true)
      if (Option.isSome(loaded)) {
        expect([...loaded.value.blocks]).toStrictEqual([1, 2, 3, 4])
        expect(loaded.value.blocks).toBeInstanceOf(Uint8Array)
      }
    }).pipe(Effect.provide(layerFor(makeFakeIndexedDb()))),
  )
})
