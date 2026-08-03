/**
 * `StoragePort` — the seam between a save format and the medium it lands on.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * ---------------------------------------------------------------------------
 * Why the Port is this narrow
 * ---------------------------------------------------------------------------
 *
 * The reference implementation's storage service had seven methods, and four of
 * them (`saveChunk`, `loadChunk`, `saveWorldMetadata`, `loadWorldMetadata`)
 * were the same two operations specialised to two payload types
 * (`packages/world/infrastructure/storage-service.ts:96-139`). The domain
 * knowledge — that a chunk is keyed `worldId:x:z` and metadata by bare
 * `worldId` (`storage-idb-model.ts:27-28`) — lived inside the adapter, so
 * adding a fifth kind of saved thing meant editing the IndexedDB code.
 *
 * Here the adapter knows only keys and envelopes. Which key a chunk gets is
 * mc-worldgen's business, because mc-worldgen is what defines the chunk format.
 *
 * The narrowness is also what made five different in-memory doubles necessary
 * over there — `packages/world/test/storage-service-test-utils.ts:49-125`,
 * `:129-189`, `chunk-manager-test-utils.ts:20-39`,
 * `block-cycle-test-utils.ts:22-34`, and a fifth inline at
 * `storage-service.property.test.ts:30-42`, whose own comment admits it
 * "mirrors makeInMemoryStorageService". Worse, the main double replaced Schema
 * decoding with hand-written type guards (`storage-service-test-utils.ts:30-44`),
 * so its notion of "corrupt" did not match production's. One canonical
 * in-memory adapter ships from this module for exactly that reason.
 */
import { Brand, Context, Effect, Layer, Option, Ref } from 'effect'
import { StorageError } from './errors'
import type { SaveEnvelope } from './envelope'

/**
 * An opaque storage key.
 *
 * Refined rather than nominal so that an empty key — which several storage
 * backends silently accept and then cannot enumerate — is rejected at the
 * constructor rather than discovered later.
 */
export type SaveKey = string & Brand.Brand<'SaveKey'>

export const SaveKey = Brand.refined<SaveKey>(
  (value) => value.trim().length > 0,
  (value) => Brand.error(`SaveKey must be a non-blank string, received ${JSON.stringify(value)}`),
)

/** One ordered change in an atomic storage checkpoint. */
export type StorageMutation =
  | { readonly _tag: 'Put'; readonly key: SaveKey; readonly envelope: SaveEnvelope }
  | { readonly _tag: 'Remove'; readonly key: SaveKey }

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
   * A value rather than a function: listing takes no arguments, and the
   * reference implementation made exactly this distinction for
   * `listWorldMetadata` (`storage-service.ts:168`) — worth keeping, because it
   * is the shape that makes `yield* storage.keys` read correctly.
   */
  readonly keys: Effect.Effect<ReadonlyArray<SaveKey>, StorageError>
}

export class StoragePort extends Context.Tag('@nerima-games/mc-save/StoragePort')<StoragePort, StorageService>() {}

/**
 * The canonical in-memory adapter.
 *
 * Not a test-only convenience: it is the reference semantics that every real
 * adapter must match, and the contract tests in `test/storage-port.test.ts` are
 * written against the interface so they can be re-run against the IndexedDB
 * adapter when it lands.
 *
 * `Ref<HashMap>` rather than a raw `Map`: `put` and `remove` must be atomic
 * with respect to `keys`, and `Ref.update` gives that without a lock.
 */
export const makeInMemoryStorage: Effect.Effect<StorageService> = Effect.gen(function* () {
  const store = yield* Ref.make<ReadonlyMap<string, SaveEnvelope>>(new Map())

  return {
    get: (key) =>
      Ref.get(store).pipe(Effect.map((current) => Option.fromNullable(current.get(key)))),

    put: (key, envelope) =>
      Ref.update(store, (current) => {
        const next = new Map(current)
        next.set(key, envelope)
        return next
      }),

    remove: (key) =>
      Ref.update(store, (current) => {
        const next = new Map(current)
        next.delete(key)
        return next
      }),

    commitBatch: (mutations) =>
      Ref.update(store, (current) => {
        const next = new Map(current)
        for (const mutation of mutations) {
          if (mutation._tag === 'Put') {
            next.set(mutation.key, mutation.envelope)
          } else {
            next.delete(mutation.key)
          }
        }
        return next
      }),

    readBatch: (keys) =>
      Ref.get(store).pipe(
        Effect.map((current) => keys.map((key) => Option.fromNullable(current.get(key)))),
      ),

    keys: Ref.get(store).pipe(Effect.map((current) => [...current.keys()].map((key) => SaveKey(key)))),
  }
})

export const InMemoryStorageLayer: Layer.Layer<StoragePort> = Layer.effect(StoragePort, makeInMemoryStorage)

/**
 * An adapter that fails every write, for testing the caller's error path.
 *
 * The reference needed this too (`storage-service-test-utils.ts:129-189`) and
 * hand-rolled it per test file. Shipping it means the retry/quota policy that
 * eventually sits on top of `StoragePort` can be tested by the repository that
 * owns the policy, not by whoever remembers to write a fake.
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
