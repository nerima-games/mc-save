import { describe, expect } from 'vitest'
import { Effect } from 'effect'
import { effect } from './support/effect-test.js'
import {
  INSERTION_INDEX_NAME,
  indexedDbStorageLayer,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
} from '../src/domain/indexeddb-storage.js'
import { SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { makeFakeIndexedDb, type FakeIndexedDb } from './fake-indexeddb.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

const DATABASE = 'mc-save/test/worlds'
const A = SaveKey('alpha')
const B = SaveKey('beta')
const envelope = (payload: unknown) => sealedTestEnvelope('mc-save/test/idb', 1, payload)

const layerFor = (factory: FakeIndexedDb, databaseName = DATABASE) =>
  indexedDbStorageLayer({ factory, databaseName })

describe('the IndexedDB adapter owns its database and layout', () => {
  effect('creates a database under the name it was given, and no other', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ world: 1 }))
      }).pipe(Effect.provide(layerFor(factory, 'a-name-mc-save-did-not-choose')))

      expect(factory.databaseNames()).toStrictEqual(['a-name-mc-save-did-not-choose'])
    }),
  )

  effect('creates its own store layout, not a game-specific chunks/metadata layout', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(factory.storeNamesOf(DATABASE)).toStrictEqual([SAVE_STORE_NAME])
      expect(factory.storeNamesOf(DATABASE)).not.toContain('chunks')
      expect(factory.storeNamesOf(DATABASE)).not.toContain('metadata')
      expect(factory.indexNamesOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([INSERTION_INDEX_NAME])
    }),
  )

  effect('the store is non-empty after a save, and holds one record per key', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
        yield* storage.put(B, envelope({ n: 2 }))
        yield* storage.put(A, envelope({ n: 3 }))
      }).pipe(Effect.provide(layerFor(factory)))

      const records = factory.recordsOf(DATABASE, SAVE_STORE_NAME) ?? []
      expect(records.length).toBe(2)
    }),
  )

  effect('the record shape is inspectable: key, insertion sequence, envelope', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: envelope({ n: 1 }) },
      ])
    }),
  )

  effect('opens at the layout version it declares', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        yield* StoragePort
      }).pipe(Effect.provide(layerFor(factory)))

      const listed = (yield* Effect.promise(() => factory.databases?.() ?? Promise.resolve([]))) ?? []
      expect(listed).toStrictEqual([{ name: DATABASE, version: STORE_LAYOUT_VERSION }])
    }),
  )
})
