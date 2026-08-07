/**
 * The IndexedDB adapter for `StoragePort`.
 *
 * ---------------------------------------------------------------------------
 * What this adapter knows, and what it refuses to know
 * ---------------------------------------------------------------------------
 *
 * It knows KEYS and ENVELOPES. It does not know what a chunk is, what world
 * metadata is, or what the game's database is called — `databaseName` is the
 * caller's, exactly as the key is. That is the whole inversion `index.ts` and
 * `domain/storage-port.ts` describe: the reference implementation's storage
 * service hard-coded `'minecraft-worlds'` and the stores `'chunks'` and
 * `'metadata'` (`storage-idb-model.ts:8-11`), so adding a fifth kind of saved
 * thing meant editing the IndexedDB code, and persistence could not be
 * separated from world generation.
 *
 * `docs/design-notes.md` asks for a regression test that "the IndexedDB adapter
 * opens 'minecraft-worlds', not 'ts-minecraft'" — one line, but getting it wrong
 * makes every player's worlds look deleted. That constant now belongs to
 * whoever composes the game, because it is a fact about the game and not about
 * persistence. mc-save's half of the claim is the one it can actually own, and
 * it is tested: the adapter opens THE NAME IT WAS GIVEN, verbatim.
 *
 * ---------------------------------------------------------------------------
 * The store layout, which is this adapter's own
 * ---------------------------------------------------------------------------
 *
 * One store, `saves`, with in-line keys at `keyPath: 'key'`, and one index,
 * `by-insertion`, over a monotonic `seq`. A record is
 * `{ key, seq, envelope }`.
 *
 * The index is not decoration. `StorageService.keys` is documented as "every key
 * currently present, IN INSERTION ORDER", and IndexedDB enumerates in ascending
 * KEY order — so the obvious implementation (`store.getAllKeys()`) returns the
 * right set in the wrong order, and would have failed the contract test that
 * writes `beta` then `alpha` and expects `[beta, alpha]`. That test only ran
 * against the in-memory adapter until now, which is precisely the trap the
 * reference fell into: five hand-written doubles, none ever checked against the
 * real adapter (`docs/public-api.md` §5). Running the SAME contract block
 * against this adapter is what turned a documented promise into a caught bug.
 *
 * ---------------------------------------------------------------------------
 * `onupgradeneeded`, and a database written by an older version
 * ---------------------------------------------------------------------------
 *
 * The upgrade creates the store and its index IF THEY ARE ABSENT, and does
 * nothing else. It does not read `oldVersion` — it cannot, because
 * `domain/indexeddb-surface.ts` makes the event unreadable on purpose (see its
 * header for the type-level reason and for why that is a feature).
 *
 * So, concretely: a database written by ANY older layout version opens, gains
 * whatever structure it was missing, and KEEPS EVERY RECORD IT HAD. Nothing is
 * rewritten and nothing is dropped. That is deliberate and it is the rule
 * `docs/public-api.md` §8 states — schema migration is `defineFormat`'s chain,
 * operating on the envelope's `version` at decode time, and the IndexedDB
 * upgrade is limited to store STRUCTURE. Mixing the two is how the reference
 * ended up with two version numbers that did nothing (`domain/envelope.ts`
 * header) and an upgrade callback whose data path never ran.
 *
 * The one thing this costs: when a future `STORE_LAYOUT_VERSION` needs to add an
 * index to an ALREADY EXISTING store, the branch below will not fire, because it
 * only looks at whether the store is there. Reaching an existing store during an
 * upgrade needs `IDBOpenDBRequest.transaction`, which is deliberately NOT in the
 * surface today. Adding that member is the honest cost of that change, and this
 * paragraph is here so that whoever makes it knows the cost is a surface change
 * and a fixture change, not a cast.
 *
 * ---------------------------------------------------------------------------
 * Why every operation is one `Effect.async`, and not an `Effect.gen` chain
 * ---------------------------------------------------------------------------
 *
 * An IndexedDB transaction commits automatically as soon as control returns to
 * the event loop with no request outstanding on it. A `put` needs three requests
 * (read the old record, find the next sequence number, write), and writing them
 * as three `yield*`-ed Effects would let the runtime yield between them — the
 * transaction would commit after the first, and the second would throw
 * `TransactionInactiveError`. Intermittently, and only under load.
 *
 * So each operation issues its whole request chain SYNCHRONOUSLY, from inside
 * the previous request's `onsuccess`, and resumes the Effect once. The fake in
 * `test/fake-indexeddb.ts` models that auto-commit rule specifically so this
 * property is tested rather than assumed.
 */
import { Effect, Layer, Option, Schema, Scope } from 'effect'
import { SaveEnvelopeSchema, type SaveEnvelope } from './envelope'
import { StorageError } from './errors'
import type { IdbDatabase, IdbFactory, IdbObjectStore, IdbRequest } from './indexeddb-surface'
import { SaveKey, StoragePort, type StorageService } from './storage-port'

/** The one object store this adapter creates. Deliberately not `chunks`/`metadata`. */
export const SAVE_STORE_NAME = 'saves'

/** The index that makes `keys` answer in insertion order rather than key order. */
export const INSERTION_INDEX_NAME = 'by-insertion'

/**
 * The version of the STORE LAYOUT — not of anything saved in it.
 *
 * Bumping this runs `onupgradeneeded`. It has nothing to do with a save
 * format's version, which lives in the envelope and is migrated by
 * `defineFormat`'s chain. Two numbers that both looked like "the save version"
 * is the confusion `domain/envelope.ts` was written to end.
 */
export const STORE_LAYOUT_VERSION = 1

/**
 * The marker appended to `StorageError.operation` when the medium said it is
 * full.
 *
 * The error CHANNEL is not widened — `StorageService` promises `StorageError`
 * and that is what every failure here is. But the caller's correct response
 * genuinely differs, and `domain/errors.ts` says so: the retry policy the
 * reference wrapped around this (`Schedule.exponential(100ms)`, 3 attempts,
 * "aborting on `QuotaExceededError`") "belongs on top of this type rather than
 * inside it". A policy on top can only act on what it can see, so the one
 * distinction it needs is spelled into `operation` and read back by
 * `isQuotaExceeded`. Everything else is retryable and needs no marker.
 */
export const QUOTA_EXCEEDED_MARKER = ':quota-exceeded'

/** The `DOMException.name` the browser uses when storage is full. */
const QUOTA_EXCEEDED_NAME = 'QuotaExceededError'

/**
 * Whether this failure means "the disk is full" rather than "the medium
 * hiccuped".
 *
 * Retrying a quota failure is pointless and, on a background autosave loop,
 * actively harmful: it burns the frame budget re-attempting a write that cannot
 * succeed until the player deletes something.
 */
export const isQuotaExceeded = (error: StorageError): boolean =>
  error.operation.endsWith(QUOTA_EXCEEDED_MARKER)

export type IndexedDbStorageOptions = {
  /**
   * `globalThis.indexedDB` in a browser; `test/fake-indexeddb.ts` in a test.
   *
   * Injected rather than reached for, because reaching for a global is what
   * would have required `"DOM"` in `tsconfig.base.json` — and because an adapter
   * that takes its medium as an argument is one that can be tested at all.
   */
  readonly factory: IdbFactory
  /**
   * The database name. THE CALLER'S, not this repository's.
   *
   * mc-save has no business naming the game's database, for the same reason it
   * has no business knowing that a chunk is keyed `worldId:x:z`.
   */
  readonly databaseName: string
}

// ---------------------------------------------------------------------------
// Error construction
// ---------------------------------------------------------------------------

/**
 * `exactOptionalPropertyTypes` is on, so an absent `key` or `cause` has to be
 * genuinely absent rather than explicitly `undefined`. Spreading is the least
 * noisy way to say that once instead of at eight call sites.
 */
const storageError = (
  operation: string,
  key: string | undefined,
  cause: unknown,
): StorageError =>
  new StorageError({
    operation,
    ...(key === undefined ? {} : { key }),
    ...(cause === undefined ? {} : { cause }),
  })

/**
 * Name the operation, marking quota when the medium said so.
 *
 * `cause` is whatever the DOM handed over — a `DOMException`-shaped thing, or
 * `null` on a browser-initiated abort, which really does happen and really does
 * arrive with no error attached.
 */
const failureFor = (operation: string, key: string | undefined, cause: unknown): StorageError => {
  const named =
    typeof cause === 'object' && cause !== null && readString(cause, 'name') === QUOTA_EXCEEDED_NAME
      ? `${operation}${QUOTA_EXCEEDED_MARKER}`
      : operation
  return storageError(named, key, cause)
}

// ---------------------------------------------------------------------------
// Reading back what some other build wrote
// ---------------------------------------------------------------------------

/**
 * The single `as` in this file, confined to one function.
 *
 * Everything IndexedDB returns is `unknown` by the surface's own design, and
 * narrowing `unknown` to "an object I may index" cannot be expressed without
 * one assertion. Confining it here means every read below is a total function
 * over `unknown`, and none of them can be given a shape they did not check.
 */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const readString = (source: unknown, field: string): string | undefined => {
  const value = asRecord(source)?.[field]
  return typeof value === 'string' ? value : undefined
}

const readNumber = (source: unknown, field: string): number | undefined => {
  const value = asRecord(source)?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Pull and decode the envelope out of one of our own records.
 *
 * The IndexedDB surface returns `unknown`, so the envelope must cross the
 * `SaveEnvelope` boundary through the same schema used by persistence. Strict
 * excess-property parsing keeps future or corrupted fields from being silently
 * exposed as a trusted envelope; format migrations still happen later in
 * `domain/persistence.ts` and `domain/format.ts`.
 */
const decodeSaveEnvelope = Schema.decodeUnknownSync(SaveEnvelopeSchema, {
  onExcessProperty: 'error',
})

const readEnvelope = (record: unknown): SaveEnvelope | undefined => {
  const fields = asRecord(record)
  if (fields === undefined || typeof fields['key'] !== 'string') {
    return undefined
  }
  const envelope = fields['envelope']
  if (envelope === undefined) {
    return undefined
  }
  const envelopeFields = asRecord(envelope)
  if (
    envelopeFields === undefined ||
    !Object.prototype.hasOwnProperty.call(envelopeFields, 'payload')
  ) {
    throw new TypeError('IndexedDB save envelope is missing payload')
  }
  return decodeSaveEnvelope(envelope)
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

const openDatabase = (options: IndexedDbStorageOptions): Effect.Effect<IdbDatabase, StorageError> =>
  Effect.async<IdbDatabase, StorageError>((resume) => {
    const operation = 'indexeddb.open'
    let settled = false

    const settle = (outcome: Effect.Effect<IdbDatabase, StorageError>): void => {
      if (settled) {
        return
      }
      settled = true
      resume(outcome)
    }

    const request = options.factory.open(options.databaseName, STORE_LAYOUT_VERSION)

    request.onupgradeneeded = () => {
      // Store-structure only. See this file's header for what happens to a
      // database written by an older version, and why nothing is rewritten.
      const database = request.result
      if (!database.objectStoreNames.contains(SAVE_STORE_NAME)) {
        const store = database.createObjectStore(SAVE_STORE_NAME, { keyPath: 'key' })
        store.createIndex(INSERTION_INDEX_NAME, 'seq')
      }
    }

    request.onblocked = () => {
      // The DOM does not treat this as an error: the open stays pending until
      // whoever holds the old version closes it, possibly forever. Waiting is
      // the worse failure — the player gets a title screen that never loads and
      // no message. Failing here at least reaches the UI, and the caller's
      // retry policy can decide to try again, which for this one really might
      // work later.
      settle(
        Effect.fail(
          storageError(
            `${operation}:blocked`,
            options.databaseName,
            'another connection is holding an older version of this database open',
          ),
        ),
      )
    }

    request.onerror = () => {
      settle(Effect.fail(failureFor(operation, options.databaseName, request.error)))
    }

    request.onsuccess = () => {
      const database = request.result
      // Without this, THIS connection is what makes the next version of the
      // game fire `onblocked` in another tab. Closing costs an in-flight save
      // at worst; not closing costs every future release its first launch.
      database.onversionchange = () => {
        database.close()
      }
      settle(Effect.succeed(database))
    }
  })

// ---------------------------------------------------------------------------
// One transaction, one Effect
// ---------------------------------------------------------------------------

/**
 * Run a request chain inside a single transaction and resume once.
 *
 * `start` issues its requests synchronously and calls `deliver` with the answer;
 * the Effect resumes on `oncomplete`, NOT on the last request's `onsuccess`.
 * That ordering is the point: a `put` request succeeding means the value reached
 * the transaction, not the disk, and the transaction can still abort under
 * storage pressure afterwards. The reference resolved on the request and so
 * reported saves that had not happened.
 */
const runTransaction = <A>(
  database: IdbDatabase,
  mode: 'readonly' | 'readwrite',
  operation: string,
  key: string | undefined,
  start: (
    store: IdbObjectStore,
    deliver: (value: A) => void,
    onResult: (request: IdbRequest, next: (result: unknown) => void) => void,
  ) => void,
): Effect.Effect<A, StorageError> =>
  Effect.async<A, StorageError>((resume) => {
    let settled = false
    let delivered: { readonly value: A } | undefined
    let pendingFailure: { readonly cause: unknown } | undefined

    const settle = (outcome: Effect.Effect<A, StorageError>): void => {
      if (settled) {
        return
      }
      settled = true
      resume(outcome)
    }

    const fail = (cause: unknown): void => {
      settle(Effect.fail(failureFor(operation, key, cause)))
    }

    // `transaction()` throws synchronously when the connection has been closed
    // (`InvalidStateError`) or the store is missing (`NotFoundError`). Both are
    // real states — the first is what `onversionchange` above deliberately
    // creates — so they are failures, not defects.
    let transaction
    try {
      transaction = database.transaction(SAVE_STORE_NAME, mode)
    } catch (cause) {
      fail(cause)
      return
    }

    transaction.onerror = () => {
      pendingFailure ??= { cause: transaction.error }
    }
    transaction.onabort = () => {
      // Wait for abort before reporting failure: only then is rollback complete.
      fail(pendingFailure?.cause ?? transaction.error)
    }
    transaction.oncomplete = () => {
      settle(
        delivered === undefined
          ? Effect.fail(
              storageError(
                `${operation}:incomplete`,
                key,
                'the transaction committed without producing a result',
              ),
            )
          : Effect.succeed(delivered.value),
      )
    }

    /**
     * Run one step of the chain, routing anything it throws into the Effect.
     *
     * This wrapper is not optional. A success handler runs from the MEDIUM'S
     * callback, not from inside the `Effect.async` register function, so a
     * `throw` there does not unwind into the `try` below — it escapes as an
     * unhandled exception, the Effect never settles, and the caller hangs. That
     * is not hypothetical: it is what the first version of this file did, and
     * the test "a record this adapter did not write is an error, never a silent
     * none" caught it as an uncaught exception plus a timeout rather than as the
     * `StorageError` it was asserting.
     *
     * The transaction is aborted as well as reported, so a chain that failed
     * halfway cannot commit the half it managed.
     */
    const guard = (body: () => void): void => {
      try {
        body()
      } catch (cause) {
        pendingFailure = { cause }
        try {
          transaction.abort()
        } catch {
          fail(cause)
        }
      }
    }

    const onResult = (request: IdbRequest, next: (result: unknown) => void): void => {
      request.onsuccess = () => {
        guard(() => {
          next(request.result)
        })
      }
      request.onerror = () => {
        pendingFailure ??= { cause: request.error }
        try {
          transaction.abort()
        } catch {
          fail(request.error)
        }
      }
    }

    guard(() => {
      start(
        transaction.objectStore(SAVE_STORE_NAME),
        (value) => {
          delivered = { value }
        },
        onResult,
      )
    })
  })

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

const serviceFor = (database: IdbDatabase): StorageService => ({
  get: (key) =>
    runTransaction<Option.Option<SaveEnvelope>>(
      database,
      'readonly',
      'indexeddb.get',
      key,
      (store, deliver, onResult) => {
        onResult(store.get(key), (record) => {
          // An absent key is `undefined`, and that is `none` — a missing save is
          // a new world, not an error (`domain/persistence.ts`).
          if (record === undefined) {
            deliver(Option.none())
            return
          }
          const envelope = readEnvelope(record)
          if (envelope === undefined) {
            // A record that is present but is not one of ours must NOT come back
            // as `none`. `none` means "new world" all the way up the stack, and
            // the player would be shown fresh terrain where their house was.
            throw new TypeError(
              `${SAVE_STORE_NAME} holds a record at "${key}" that this adapter did not write`,
            )
          }
          deliver(Option.some(envelope))
        })
      },
    ),

  put: (key, envelope) =>
    runTransaction<void>(database, 'readwrite', 'indexeddb.put', key, (store, deliver, onResult) => {
      onResult(store.get(key), (existing) => {
        const existingSeq = readNumber(existing, 'seq')
        if (existingSeq !== undefined) {
          // An overwrite keeps its ORIGINAL position. The in-memory adapter gets
          // this free from `Map`, whose `set` does not move an existing key, and
          // the contract test "put overwrites rather than appending" checks it.
          store.put({ key, seq: existingSeq, envelope })
          deliver(undefined)
          return
        }
        // A new key goes at the end. The largest existing `seq` is one cursor
        // step away through the index; counting records instead would reuse a
        // number after a delete and silently reorder the enumeration.
        onResult(store.index(INSERTION_INDEX_NAME).openCursor(null, 'prev'), (cursor) => {
          const highest = readNumber(asRecord(cursor)?.['value'], 'seq')
          store.put({ key, seq: highest === undefined ? 0 : highest + 1, envelope })
          deliver(undefined)
        })
      })
    }),

  remove: (key) =>
    runTransaction<void>(database, 'readwrite', 'indexeddb.remove', key, (store, deliver, onResult) => {
      // `delete` on an absent key succeeds in IndexedDB, which is exactly what
      // the contract asks for ("removing an absent key is not an error").
      onResult(store.delete(key), () => {
        deliver(undefined)
      })
    }),

  commitBatch: (mutations) =>
    mutations.length === 0
      ? Effect.void
      : runTransaction<void>(
          database,
          'readwrite',
          'indexeddb.commitBatch',
          undefined,
          (store, deliver, onResult) => {
            const apply = (index: number, nextSequence: number): void => {
              const mutation = mutations[index]
              if (mutation === undefined) {
                deliver(undefined)
                return
              }
              if (mutation._tag === 'Remove') {
                onResult(store.delete(mutation.key), () => apply(index + 1, nextSequence))
                return
              }
              onResult(store.get(mutation.key), (existing) => {
                const existingSequence = readNumber(existing, 'seq')
                const sequence = existingSequence ?? nextSequence
                onResult(store.put({ key: mutation.key, seq: sequence, envelope: mutation.envelope }), () =>
                  apply(index + 1, existingSequence === undefined ? nextSequence + 1 : nextSequence),
                )
              })
            }

            onResult(store.index(INSERTION_INDEX_NAME).openCursor(null, 'prev'), (cursor) => {
              const highest = readNumber(asRecord(cursor)?.['value'], 'seq')
              apply(0, highest === undefined ? 0 : highest + 1)
            })
          },
        ),

  readBatch: (keys) =>
    keys.length === 0
      ? Effect.succeed([])
      : runTransaction<ReadonlyArray<Option.Option<SaveEnvelope>>>(
          database,
          'readonly',
          'indexeddb.readBatch',
          undefined,
          (store, deliver, onResult) => {
            const results: Array<Option.Option<SaveEnvelope>> = []
            const read = (index: number): void => {
              const key = keys[index]
              if (key === undefined) {
                deliver(results)
                return
              }
              onResult(store.get(key), (record) => {
                if (record === undefined) {
                  results.push(Option.none())
                } else {
                  const envelope = readEnvelope(record)
                  if (envelope === undefined) {
                    throw new TypeError(
                      `${SAVE_STORE_NAME} holds a record at "${key}" that this adapter did not write`,
                    )
                  }
                  results.push(Option.some(envelope))
                }
                read(index + 1)
              })
            }
            read(0)
          },
        ),

  keys: runTransaction<ReadonlyArray<SaveKey>>(
    database,
    'readonly',
    'indexeddb.keys',
    undefined,
    (store, deliver, onResult) => {
      // Through the index, so the answer is in insertion order. `getAllKeys` on
      // an index returns the PRIMARY keys of the matching records, ordered by
      // the index key — one request, no cursor walk.
      onResult(store.index(INSERTION_INDEX_NAME).getAllKeys(), (result) => {
        deliver(readKeys(result))
      })
    },
  ),
})

/**
 * Turn the raw key list into `SaveKey`s, refusing anything that is not one.
 *
 * Throwing here (caught by `runTransaction`'s `try`) rather than skipping the
 * bad entry is the deliberate choice. Skipping would mean a world silently
 * missing from the world list, and `test/binary-roundtrip.test.ts` states what
 * that costs: an absent save "does not read as an error anywhere up the stack —
 * it reads as fresh terrain". A loud failure is recoverable; a quietly shorter
 * list is not.
 */
const readKeys = (result: unknown): ReadonlyArray<SaveKey> => {
  if (!Array.isArray(result)) {
    throw new TypeError(`${INSERTION_INDEX_NAME} returned ${typeof result}, not a list of keys`)
  }
  return result.map((entry: unknown) => {
    if (typeof entry !== 'string') {
      throw new TypeError(`${SAVE_STORE_NAME} holds a record keyed by ${typeof entry}, not a string`)
    }
    return SaveKey(entry)
  })
}

/**
 * Open the database and build the service, closing the connection on release.
 *
 * Scoped rather than plain, because a connection that is never closed blocks the
 * next version of the game from upgrading — the `onblocked` path above, seen
 * from the other side.
 */
export const makeIndexedDbStorage = (
  options: IndexedDbStorageOptions,
): Effect.Effect<StorageService, StorageError, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(openDatabase(options), (database) =>
      Effect.sync(() => {
        database.close()
      }),
    ),
    serviceFor,
  )

export const indexedDbStorageLayer = (
  options: IndexedDbStorageOptions,
): Layer.Layer<StoragePort, StorageError> =>
  Layer.scoped(StoragePort, makeIndexedDbStorage(options))
