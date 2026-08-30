import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect } from 'effect'
import { StorageError } from '../src/domain/errors.js'
import { failingStorageLayer, InMemoryStorageLayer, SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { storagePortContract } from './storage-port-contract.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

/**
 * These are contract tests, not tests of the in-memory adapter.
 *
 * Every assertion is phrased against `StoragePort` rather than against the
 * implementation, so the whole block can be re-run against another adapter. It
 * now is: the block itself lives in `test/storage-port-contract.ts` and is run
 * from here against `InMemoryStorageLayer` and from
 * `test/indexeddb-storage.test.ts` against the IndexedDB adapter. Not one
 * assertion changed when it moved.
 *
 * The shared contract keeps these assertions independent of the adapter. The
 * same block is run against the in-memory and IndexedDB implementations, so a
 * backend cannot silently develop semantics that differ from production.
 */

const A = SaveKey('alpha')
const envelope = (payload: unknown) => sealedTestEnvelope('mc-save/test/contract', 1, payload)

storagePortContract('in-memory', () => InMemoryStorageLayer)

describe('SaveKey', () => {
  effect('rejects a blank key, which several backends accept and then cannot enumerate', () =>
    Effect.sync(() => {
      expect(() => SaveKey('')).toThrow()
      expect(() => SaveKey('   ')).toThrow()
      expect(SaveKey('world-1/chunk/0:0')).toBe('world-1/chunk/0:0')
    }),
  )
})

describe('failingStorageLayer', () => {
  effect('fails writes with a StorageError naming the operation and key', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const error = yield* Effect.flip(storage.put(A, envelope({})))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('quota-exceeded')
      expect(error.message).toContain('alpha')
    }).pipe(Effect.provide(failingStorageLayer('quota-exceeded'))),
  )

  effect('fails every other method the same way, each naming the operation', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort

      const get = yield* Effect.flip(storage.get(A))
      const remove = yield* Effect.flip(storage.remove(A))
      const commitBatch = yield* Effect.flip(storage.commitBatch([{ _tag: 'Remove', key: A }]))
      const readBatch = yield* Effect.flip(storage.readBatch([A]))

      for (const error of [get, remove, commitBatch, readBatch]) {
        expect(error._tag).toBe('StorageError')
        expect(error.operation).toBe('unavailable')
      }
      // `get` and `remove` are keyed like `put`; `commitBatch` and `readBatch`
      // are not, the same asymmetry `StorageService`'s own shape has.
      expect(get.key).toBe('alpha')
      expect(remove.key).toBe('alpha')
      expect(commitBatch.key).toBeUndefined()
      expect(readBatch.key).toBeUndefined()
    }).pipe(Effect.provide(failingStorageLayer('unavailable'))),
  )
})

describe('StorageError.message', () => {
  effect('omits the key clause when no key is involved', () =>
    Effect.sync(() => {
      // The other half of the "fails writes ... naming the operation and key"
      // assertion above: `put`'s error names its key, but `commitBatch` and
      // `readBatch` fail with no key at all, and the message getter has a
      // ternary specifically for that case.
      expect(new StorageError({ operation: 'indexeddb.commitBatch' }).message).toBe(
        'storage operation "indexeddb.commitBatch" failed',
      )
    }),
  )
})
