import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { saveEnvelope } from '../domain/envelope'
import { failingStorageLayer, InMemoryStorageLayer, SaveKey, StoragePort } from '../domain/storage-port'

/**
 * These are contract tests, not tests of the in-memory adapter.
 *
 * Every assertion here is phrased against `StoragePort` rather than against the
 * implementation, so the whole block can be re-run against the IndexedDB
 * adapter when it lands. The reference implementation had the opposite: five
 * separate hand-rolled doubles (`storage-service-test-utils.ts:49-125` and
 * `:129-189`, `chunk-manager-test-utils.ts:20-39`,
 * `block-cycle-test-utils.ts:22-34`, plus one inline at
 * `storage-service.property.test.ts:30-42`), none of which was checked against
 * the real adapter. The main one even swapped Schema decoding for hand-written
 * type guards (`storage-service-test-utils.ts:30-44`), so "corrupt" meant
 * something different in tests than in production.
 */

const A = SaveKey('alpha')
const B = SaveKey('beta')
const envelope = (payload: unknown) => saveEnvelope('mc-save/test/contract', 1, payload)

describe('StoragePort contract', () => {
  it.effect('get returns none for a key never written', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      expect(yield* storage.get(A)).toStrictEqual(Option.none())
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  it.effect('get returns what put wrote', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(A, envelope({ n: 1 }))
      expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ n: 1 })))
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  it.effect('put overwrites rather than appending', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(A, envelope({ n: 1 }))
      yield* storage.put(A, envelope({ n: 2 }))

      expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ n: 2 })))
      expect(yield* storage.keys).toStrictEqual([A])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  it.effect('remove makes a key absent, and removing an absent key is not an error', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(A, envelope({}))
      yield* storage.remove(A)
      yield* storage.remove(A)

      expect(yield* storage.get(A)).toStrictEqual(Option.none())
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  it.effect('keys lists every written key in insertion order', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(B, envelope({}))
      yield* storage.put(A, envelope({}))

      expect(yield* storage.keys).toStrictEqual([B, A])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  it.effect('writes are isolated between layer instances, so tests cannot leak into each other', () =>
    Effect.gen(function* () {
      const first = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
        return yield* storage.keys
      }).pipe(Effect.provide(InMemoryStorageLayer))

      const second = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* storage.keys
      }).pipe(Effect.provide(InMemoryStorageLayer))

      expect(first).toStrictEqual([A])
      expect(second).toStrictEqual([])
    }),
  )
})

describe('SaveKey', () => {
  it.effect('rejects a blank key, which several backends accept and then cannot enumerate', () =>
    Effect.sync(() => {
      expect(() => SaveKey('')).toThrow()
      expect(() => SaveKey('   ')).toThrow()
      expect(SaveKey('world-1/chunk/0:0')).toBe('world-1/chunk/0:0')
    }),
  )
})

describe('failingStorageLayer', () => {
  it.effect('fails writes with a StorageError naming the operation and key', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const error = yield* Effect.flip(storage.put(A, envelope({})))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('quota-exceeded')
      expect(error.message).toContain('alpha')
    }).pipe(Effect.provide(failingStorageLayer('quota-exceeded'))),
  )
})
