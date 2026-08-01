/**
 * NOT A TEST — the `StoragePort` contract, as a block that any adapter can be
 * run through.
 *
 * `domain/storage-port.ts` makes a promise about `makeInMemoryStorage`:
 *
 *   > it is the reference semantics that every real adapter must match, and the
 *   > contract tests in `test/storage-port.test.ts` are written against the
 *   > interface so they can be re-run against the IndexedDB adapter when it
 *   > lands.
 *
 * The adapter has landed, so the block moved here and is now run twice — once
 * against `InMemoryStorageLayer` from `test/storage-port.test.ts`, once against
 * `indexedDbStorageLayer` from `test/indexeddb-storage.test.ts`. Not one
 * assertion changed in the move.
 *
 * That promise was worth keeping rather than quietly dropping: re-running these
 * exact assertions against the real adapter is what caught the insertion-order
 * bug. `keys` is documented as insertion order, IndexedDB enumerates in
 * ascending KEY order, and the naive `store.getAllKeys()` implementation
 * returns the right set in the wrong order. Nothing else in the suite would have
 * noticed, and the reference implementation's five unchecked doubles
 * (`docs/public-api.md` §5) are what that looks like when it is not noticed.
 *
 * `freshLayer` is a FACTORY rather than a layer, because "two independently
 * created stores do not see each other's writes" is one of the claims, and for a
 * medium-backed adapter a fresh store means a fresh database rather than a
 * fresh `Ref`.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { saveEnvelope } from '../src/domain/envelope'
import { SaveKey, StoragePort } from '../src/domain/storage-port'

const A = SaveKey('alpha')
const B = SaveKey('beta')
const envelope = (payload: unknown) => saveEnvelope('mc-save/test/contract', 1, payload)

export const storagePortContract = <E>(
  adapter: string,
  freshLayer: () => Layer.Layer<StoragePort, E>,
): void => {
  describe(`StoragePort contract — ${adapter}`, () => {
    it.effect('get returns none for a key never written', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        expect(yield* storage.get(A)).toStrictEqual(Option.none())
      }).pipe(Effect.provide(freshLayer())),
    )

    it.effect('get returns what put wrote', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
        expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ n: 1 })))
      }).pipe(Effect.provide(freshLayer())),
    )

    it.effect('put overwrites rather than appending', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
        yield* storage.put(A, envelope({ n: 2 }))

        expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ n: 2 })))
        expect(yield* storage.keys).toStrictEqual([A])
      }).pipe(Effect.provide(freshLayer())),
    )

    it.effect('remove makes a key absent, and removing an absent key is not an error', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
        yield* storage.remove(A)
        yield* storage.remove(A)

        expect(yield* storage.get(A)).toStrictEqual(Option.none())
        expect(yield* storage.keys).toStrictEqual([])
      }).pipe(Effect.provide(freshLayer())),
    )

    it.effect('keys lists every written key in insertion order', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(B, envelope({}))
        yield* storage.put(A, envelope({}))

        // `beta` before `alpha`. Ascending key order would answer the reverse,
        // which is what a medium-backed adapter does unless it is built not to.
        expect(yield* storage.keys).toStrictEqual([B, A])
      }).pipe(Effect.provide(freshLayer())),
    )

    it.effect('writes are isolated between layer instances, so tests cannot leak into each other', () =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const storage = yield* StoragePort
          yield* storage.put(A, envelope({}))
          return yield* storage.keys
        }).pipe(Effect.provide(freshLayer()))

        const second = yield* Effect.gen(function* () {
          const storage = yield* StoragePort
          return yield* storage.keys
        }).pipe(Effect.provide(freshLayer()))

        expect(first).toStrictEqual([A])
        expect(second).toStrictEqual([])
      }),
    )
  })
}
