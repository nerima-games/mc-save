/**
 * NOT A TEST — the `StoragePort` contract, as a block that any adapter can be
 * run through.
 *
 * `domain/storage-port.ts` makes a promise about `makeInMemoryStorage`:
 *
 *   > it is the reference semantics that every real adapter must match, and the
 *   > contract tests in `test/storage-port.test.ts` are written against the
 *   > interface so they can be run against every storage adapter.
 *
 * The adapter has landed, so the block moved here and is now run twice — once
 * against `InMemoryStorageLayer` from `test/storage-port.test.ts`, once against
 * `indexedDbStorageLayer` from `test/indexeddb-storage.test.ts`. Not one
 * assertion changed in the move.
 *
 * Re-running these exact assertions against the real adapter protects the
 * insertion-order contract: IndexedDB enumerates keys by key order, while this
 * port promises insertion order.
 *
 * `freshLayer` is a FACTORY rather than a layer, because "two independently
 * created stores do not see each other's writes" is one of the claims, and for a
 * medium-backed adapter a fresh store means a fresh database rather than a
 * fresh `Ref`.
 */
import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Layer, Option } from 'effect'
import { SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { sealedTestEnvelope, unsealedTestEnvelope } from './support/save-envelope.js'

const A = SaveKey('alpha')
const B = SaveKey('beta')
const envelope = (payload: unknown) => sealedTestEnvelope('mc-save/test/contract', 1, payload)
const unsealedEnvelope = (payload: unknown) => unsealedTestEnvelope('mc-save/test/contract', 1, payload)

export const storagePortContract = <E>(
  adapter: string,
  freshLayer: () => Layer.Layer<StoragePort, E>,
): void => {
  describe(`StoragePort contract — ${adapter}`, () => {
    effect('get returns none for a key never written', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        expect(yield* storage.get(A)).toStrictEqual(Option.none())
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('get returns what put wrote', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
        expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ n: 1 })))
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('put overwrites rather than appending', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
        yield* storage.put(A, envelope({ n: 2 }))

        expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ n: 2 })))
        expect(yield* storage.keys).toStrictEqual([A])
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('remove makes a key absent, and removing an absent key is not an error', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
        yield* storage.remove(A)
        yield* storage.remove(A)

        expect(yield* storage.get(A)).toStrictEqual(Option.none())
        expect(yield* storage.keys).toStrictEqual([])
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('commitBatch applies puts, overwrites, and removes in declaration order', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ old: true }))
        yield* storage.commitBatch([
          { _tag: 'Put', key: B, envelope: envelope({ n: 1 }) },
          { _tag: 'Put', key: A, envelope: envelope({ n: 2 }) },
          { _tag: 'Remove', key: B },
          { _tag: 'Put', key: B, envelope: envelope({ n: 3 }) },
        ])

        expect(yield* storage.keys).toStrictEqual([A, B])
        expect(yield* storage.readBatch([B, SaveKey('missing'), A])).toStrictEqual([
          Option.some(envelope({ n: 3 })),
          Option.none(),
          Option.some(envelope({ n: 2 })),
        ])
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('compare-and-set mutations accept matching snapshots and absence', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.commitBatch([
          { _tag: 'Put', key: A, envelope: envelope({ n: 1 }), expected: Option.none() },
          { _tag: 'Remove', key: B, expected: Option.none() },
        ])

        const first = yield* storage.get(A)
        if (Option.isNone(first)) throw new Error('the initial compare-and-set write was not stored')
        yield* storage.commitBatch([
          { _tag: 'Put', key: A, envelope: envelope({ n: 2 }), expected: Option.some(first.value) },
        ])

        const second = yield* storage.get(A)
        if (Option.isNone(second)) throw new Error('the updated compare-and-set write was not stored')
        yield* storage.commitBatch([{ _tag: 'Remove', key: A, expected: Option.some(second.value) }])
        expect(yield* storage.get(A)).toStrictEqual(Option.none())
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('stale compare-and-set mutations fail atomically', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))

        const failure = yield* Effect.flip(
          storage.commitBatch([
            { _tag: 'Put', key: B, envelope: envelope({ n: 2 }), expected: Option.none() },
            { _tag: 'Put', key: A, envelope: envelope({ n: 3 }), expected: Option.some(envelope({ n: 0 })) },
          ]),
        )
        expect(failure).toMatchObject({ _tag: 'StorageError', key: A })
        expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ n: 1 })))
        expect(yield* storage.get(B)).toStrictEqual(Option.none())
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('values are isolated from callers by the structured clone boundary', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        const payload = { nested: { value: 1 } }
        yield* storage.put(A, envelope(payload))
        payload.nested.value = 2

        const read = yield* storage.get(A)
        if (Option.isNone(read)) throw new Error('the isolated value was not stored')
        const readPayload = read.value.payload as { nested: { value: number } }
        readPayload.nested.value = 3

        const [batchRead] = yield* storage.readBatch([A])
        expect(batchRead).toStrictEqual(Option.some(envelope({ nested: { value: 1 } })))
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('structured-clone failures leave both single writes and batches unchanged', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        const invalid = unsealedEnvelope({ callback: () => undefined })

        const putFailure = yield* Effect.flip(storage.put(A, invalid))
        expect(putFailure).toMatchObject({ _tag: 'StorageError', key: A })
        expect(yield* storage.get(A)).toStrictEqual(Option.none())

        const batchFailure = yield* Effect.flip(
          storage.commitBatch([
            { _tag: 'Put', key: A, envelope: envelope({ committed: false }) },
            { _tag: 'Put', key: B, envelope: invalid },
          ]),
        )
        expect(batchFailure).toMatchObject({ _tag: 'StorageError' })
        expect(yield* storage.get(A)).toStrictEqual(Option.none())
        expect(yield* storage.get(B)).toStrictEqual(Option.none())
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('cyclic expected snapshots are treated as stale rather than crashing comparison', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        const cyclic: { self?: unknown } = {}
        cyclic.self = cyclic
        yield* storage.put(A, envelope({ n: 1 }))

        const failure = yield* Effect.flip(
          storage.commitBatch([{ _tag: 'Remove', key: A, expected: Option.some(unsealedEnvelope(cyclic)) }]),
        )
        expect(failure).toMatchObject({ _tag: 'StorageError', key: A })
        expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ n: 1 })))
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('empty batches are successful no-ops', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.commitBatch([])
        expect(yield* storage.readBatch([])).toStrictEqual([])
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('keys lists every written key in insertion order', () =>
      Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(B, envelope({}))
        yield* storage.put(A, envelope({}))

        // `beta` before `alpha`. Ascending key order would answer the reverse,
        // which is what a medium-backed adapter does unless it is built not to.
        expect(yield* storage.keys).toStrictEqual([B, A])
      }).pipe(Effect.provide(freshLayer())),
    )

    effect('writes are isolated between layer instances, so tests cannot leak into each other', () =>
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
