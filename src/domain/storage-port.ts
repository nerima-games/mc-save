/**
 * `StoragePort` — the seam between a save format and the medium it lands on.
 *
 * ---------------------------------------------------------------------------
 * Why the Port is this narrow
 * ---------------------------------------------------------------------------
 *
 * The adapter knows only keys and sealed envelopes. Which key a chunk gets is
 * the consumer's domain decision, because the consumer defines the chunk
 * format. Adding another saved value therefore requires a format definition,
 * not another storage-adapter method.
 *
 * One canonical in-memory adapter ships from this module so contract tests can
 * exercise the same port used by the IndexedDB adapter. Both adapters preserve
 * the same cloning, ordering, batch, and compare-and-set semantics.
 */
import { Context, Effect, Layer, Option, Ref } from 'effect'
import { StorageError } from './errors.js'
import type { SaveEnvelope } from './envelope.js'
import { sameSaveEnvelope } from './integrity.js'
import { SaveKey } from './save-key.js'

export { SaveKey, saveKeyForWorld } from './save-key.js'

/** One ordered change in an atomic storage checkpoint. */
export type StorageMutation =
  | {
      readonly _tag: 'Put'
      readonly key: SaveKey
      readonly envelope: SaveEnvelope
      readonly expected?: Option.Option<SaveEnvelope>
    }
  | {
      readonly _tag: 'Remove'
      readonly key: SaveKey
      readonly expected?: Option.Option<SaveEnvelope>
    }

export type StorageService = {
  readonly get: (key: SaveKey) => Effect.Effect<Option.Option<SaveEnvelope>, StorageError>
  readonly put: (key: SaveKey, envelope: SaveEnvelope) => Effect.Effect<void, StorageError>
  readonly remove: (key: SaveKey) => Effect.Effect<void, StorageError>
  /** Apply every mutation in order, or leave the store completely unchanged. */
  readonly commitBatch: (mutations: ReadonlyArray<StorageMutation>) => Effect.Effect<void, StorageError>
  /** Read keys in request order; absent keys occupy their position as `Option.none`. */
  readonly readBatch: (
    keys: ReadonlyArray<SaveKey>,
  ) => Effect.Effect<ReadonlyArray<Option.Option<SaveEnvelope>>, StorageError>
  /**
   * Every key currently present, in insertion order.
   *
   * A value rather than a function: listing takes no arguments, and this shape
   * makes `yield* storage.keys` read correctly in Effect code.
   */
  readonly keys: Effect.Effect<ReadonlyArray<SaveKey>, StorageError>
}

export class StoragePort extends Context.Tag('@nerima-games/mc-save/StoragePort')<StoragePort, StorageService>() {}

/**
 * The canonical in-memory adapter.
 *
 * Not a test-only convenience: it is the reference semantics that every real
 * adapter must match, and the contract tests are written against the interface
 * so they can be run against every storage adapter.
 *
 * `Ref<HashMap>` rather than a raw `Map`: `put` and `remove` must be atomic
 * with respect to `keys`, and `Ref.update` gives that without a lock.
 */
type CommitOutcome =
  | { readonly _tag: 'success' }
  | { readonly _tag: 'failure'; readonly error: StorageError }

const cloneStructured = <A>(value: A): A =>
  (globalThis as unknown as { readonly structuredClone: <T>(value: T) => T }).structuredClone(value)

const cloneEnvelope = (
  operation: string,
  key: SaveKey,
  envelope: SaveEnvelope,
): Effect.Effect<SaveEnvelope, StorageError> =>
  Effect.try({
    try: () => cloneStructured(envelope),
    catch: (cause) => new StorageError({ operation, key, cause }),
  })

const matchesExpected = (
  current: SaveEnvelope | undefined,
  expected: Option.Option<SaveEnvelope>,
): boolean =>
  Option.isNone(expected) ? current === undefined : current !== undefined && sameSaveEnvelope(current, expected.value)

const conflictError = (key: SaveKey): StorageError =>
  new StorageError({ operation: 'in-memory.commitBatch:conflict', key })

export const makeInMemoryStorage: Effect.Effect<StorageService> = Effect.gen(function* () {
  const store = yield* Ref.make<ReadonlyMap<string, SaveEnvelope>>(new Map())

  return {
    get: (key) =>
      Ref.get(store).pipe(
        Effect.flatMap((current) => {
          const envelope = current.get(key)
          return envelope === undefined
            ? Effect.succeed(Option.none())
            : cloneEnvelope('in-memory.get', key, envelope).pipe(Effect.map(Option.some))
        }),
      ),

    put: (key, envelope) =>
      cloneEnvelope('in-memory.put', key, envelope).pipe(
        Effect.flatMap((cloned) =>
          Ref.update(store, (current) => {
            const next = new Map(current)
            next.set(key, cloned)
            return next
          }),
        ),
      ),

    remove: (key) =>
      Ref.update(store, (current) => {
        const next = new Map(current)
        next.delete(key)
        return next
      }),

    commitBatch: (mutations) =>
      Effect.gen(function* () {
        const outcome = yield* Ref.modify(
          store,
          (current): readonly [CommitOutcome, ReadonlyMap<string, SaveEnvelope>] => {
            const next = new Map(current)
            for (const mutation of mutations) {
              const existing = next.get(mutation.key)
              if (mutation.expected !== undefined && !matchesExpected(existing, mutation.expected)) {
                return [{ _tag: 'failure', error: conflictError(mutation.key) }, current]
              }

              if (mutation._tag === 'Put') {
                try {
                  next.set(mutation.key, cloneStructured(mutation.envelope))
                } catch (cause) {
                  return [
                    {
                      _tag: 'failure',
                      error: new StorageError({ operation: 'in-memory.commitBatch', key: mutation.key, cause }),
                    },
                    current,
                  ]
                }
              } else {
                next.delete(mutation.key)
              }
            }
            return [{ _tag: 'success' }, next]
          },
        )
        if (outcome._tag === 'failure') {
          yield* Effect.fail(outcome.error)
        }
      }),

    readBatch: (keys) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(store)
        const result: Array<Option.Option<SaveEnvelope>> = []
        for (const key of keys) {
          const envelope = current.get(key)
          result.push(
            envelope === undefined
              ? Option.none()
              : Option.some(yield* cloneEnvelope('in-memory.readBatch', key, envelope)),
          )
        }
        return result
      }),

    keys: Ref.get(store).pipe(Effect.map((current) => [...current.keys()].map((key) => SaveKey(key)))),
  }
})

export const InMemoryStorageLayer: Layer.Layer<StoragePort> = Layer.effect(StoragePort, makeInMemoryStorage)

/**
 * An adapter that fails every write, for testing the caller's error path.
 *
 * The reference needed this too (`storage-service-test-utils.ts:129-189`) and
 * hand-rolled it per test file. Shipping it means the retry/quota policy in
 * `withStorageRetry` can be tested by the repository that owns the policy, not
 * by whoever remembers to write a fake.
 */
export const failingStorageLayer = (operation: string): Layer.Layer<StoragePort> =>
  Layer.succeed(StoragePort, {
    get: (key) => Effect.fail(new StorageError({ operation, key })),
    put: (key) => Effect.fail(new StorageError({ operation, key })),
    remove: (key) => Effect.fail(new StorageError({ operation, key })),
    commitBatch: () => Effect.fail(new StorageError({ operation })),
    readBatch: () => Effect.fail(new StorageError({ operation })),
    keys: Effect.fail(new StorageError({ operation })),
  })
