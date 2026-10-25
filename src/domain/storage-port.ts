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
import { Context, Effect, Layer, Option, Ref, Result, Schema } from 'effect'
import { StorageOperation } from './brand-types.js'
import { StorageError } from './errors.js'
import { SaveEnvelopeSchema, type SaveEnvelope } from './envelope.js'
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

// Same shape as mc-kernel's `ClockPort`: the tag constructor is bound to a name
// because `--isolatedDeclarations` refuses an expression in an `extends` clause.
const StoragePortBase: Context.ServiceClass<StoragePort, '@nerima-games/mc-save/StoragePort', StorageService> =
  Context.Service<StoragePort, StorageService>()('@nerima-games/mc-save/StoragePort')

export class StoragePort extends StoragePortBase {}

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

declare global {
  // structuredClone is a runtime global this repo's DOM-free `lib` does not
  // declare (see tsconfig.base.json). Declared as a `function` overload
  // (matching @types/node's own declaration form) rather than `var`, so it
  // merges cleanly with @types/node's declaration under tsconfig.test.json
  // instead of conflicting with it.
  function structuredClone<T = unknown>(value: T): T
}

const cloneStructured = <A>(value: A): A => structuredClone(value)

const cloneEnvelope = (
  operation: string,
  key: SaveKey,
  envelope: SaveEnvelope,
): Effect.Effect<SaveEnvelope, StorageError> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownResult(SaveEnvelopeSchema)(envelope),
      catch: (cause) => new StorageError({ operation, key, cause }),
    })
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(new StorageError({ operation, key, cause: decoded.failure }))
    }
    return yield* Effect.try({
      try: () => cloneStructured(decoded.success),
      catch: (cause) => new StorageError({ operation, key, cause }),
    })
  })

const snapshotDenseArray = <A>(value: unknown, operation: string): Result.Result<ReadonlyArray<A>, StorageError> => {
  const captured = Result.try({
    try: () => {
      if (!Array.isArray(value)) return undefined
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
      const length = lengthDescriptor?.value
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return undefined
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== length + 1) return undefined
      for (const key of ownKeys) {
        if (key === 'length') continue
        if (typeof key !== 'string') return undefined
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) return undefined
      }
      const values: A[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) return undefined
        values.push(descriptor.value)
      }
      return values
    },
    catch: (cause) => new StorageError({ operation, cause }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  return captured.success === undefined
    ? Result.fail(new StorageError({ operation, cause: 'batch input must be a dense array without undefined entries' }))
    : Result.succeed(captured.success)
}

const matchesExpected = (
  current: SaveEnvelope | undefined,
  expected: Option.Option<SaveEnvelope>,
  key: SaveKey,
): Result.Result<boolean, StorageError> => {
  if (Option.isNone(expected)) return Result.succeed(current === undefined)
  if (current === undefined) return Result.succeed(false)
  return Result.mapError(
    sameSaveEnvelope(current, expected.value),
    (cause) => new StorageError({ operation: 'in-memory.commitBatch', key, cause }),
  )
}

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
      Effect.suspend(() => {
        const snapshot = snapshotDenseArray<StorageMutation>(mutations, 'in-memory.commitBatch')
        if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
        return Effect.gen(function* () {
          const prepared = yield* Effect.forEach(snapshot.success, (mutation) =>
            mutation._tag === 'Put'
              ? cloneEnvelope('in-memory.commitBatch', mutation.key, mutation.envelope).pipe(
                  Effect.map((envelope): StorageMutation => ({ ...mutation, envelope })),
                )
              : Effect.succeed(mutation),
          )
          const outcome = yield* Ref.modify(
            store,
            (current): readonly [CommitOutcome, ReadonlyMap<string, SaveEnvelope>] => {
              const next = new Map(current)
              for (const mutation of prepared) {
                const existing = next.get(mutation.key)
                const matches =
                  mutation.expected === undefined
                    ? Result.succeed(true)
                    : matchesExpected(existing, mutation.expected, mutation.key)
                if (Result.isFailure(matches)) {
                  return [{ _tag: 'failure', error: matches.failure }, current]
                }
                if (!matches.success) {
                  return [{ _tag: 'failure', error: conflictError(mutation.key) }, current]
                }
                if (mutation._tag === 'Put') {
                  next.set(mutation.key, mutation.envelope)
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
        })
      }),

    readBatch: (keys) =>
      Effect.suspend(() => {
        const snapshot = snapshotDenseArray<SaveKey>(keys, 'in-memory.readBatch')
        if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
        return Effect.gen(function* () {
          const current = yield* Ref.get(store)
          const result: Array<Option.Option<SaveEnvelope>> = []
          for (const key of snapshot.success) {
            const envelope = current.get(key)
            result.push(
              envelope === undefined
                ? Option.none()
                : Option.some(yield* cloneEnvelope('in-memory.readBatch', key, envelope)),
            )
          }
          return result
        })
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
export const failingStorageLayer = (operation: StorageOperation): Layer.Layer<StoragePort> =>
  Layer.succeed(StoragePort, {
    get: (key) => Effect.fail(new StorageError({ operation, key })),
    put: (key) => Effect.fail(new StorageError({ operation, key })),
    remove: (key) => Effect.fail(new StorageError({ operation, key })),
    commitBatch: () => Effect.fail(new StorageError({ operation })),
    readBatch: () => Effect.fail(new StorageError({ operation })),
    keys: Effect.fail(new StorageError({ operation })),
  })
