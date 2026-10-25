/**
 * Transaction, error, retry, and persistence-path behavior for IndexedDB.
 *
 * Database naming and upgrade layout assertions live in focused companion
 * files so this suite can stay centered on adapter operations.
 */
import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Exit, Option, Result, Schema, Scope } from 'effect'
import { defineFormat as defineFormatResult } from '../src/domain/format.js'
import type { SaveEnvelope } from '../src/domain/envelope.js'
import {
  INSERTION_INDEX_NAME,
  indexedDbStorageLayer,
  isQuotaExceeded,
  makeIndexedDbStorage,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
} from '../src/domain/indexeddb-storage.js'
import {
  makeIdbDatabaseName,
  makeIdbVersion,
  type IdbDatabase,
  type IdbDomException,
  type IdbFactory,
  type IdbObjectStore,
  type IdbOpenRequest,
  type IdbRequest,
  type IdbStringList,
  type IdbTransaction,
} from '../src/domain/indexeddb-surface.js'
import { openDatabase, runTransaction } from '../src/domain/indexeddb-runtime.js'
import { readEnvelope, readKeys, readSequence } from '../src/domain/indexeddb-records.js'
import { loadFrom, saveTo } from '../src/domain/persistence.js'
import { SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { domException, makeFakeIndexedDb, QUOTA_EXCEEDED_ERROR } from './fake-indexeddb.js'
import { applyUntrustedArgument } from './support/apply-untrusted-argument.js'
import { storagePortContract } from './storage-port-contract.js'
import { sealedTestEnvelope, unsealedTestEnvelope } from './support/save-envelope.js'

const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<A, I>
}) => Result.getOrThrow(defineFormatResult(spec))
const DATABASE = makeIdbDatabaseName('mc-save/test/worlds')
const A = SaveKey('alpha')
const B = SaveKey('beta')
const envelope = (payload: unknown) => sealedTestEnvelope('mc-save/test/idb', 1, payload)
const unsealedEnvelope = (payload: unknown): SaveEnvelope =>
  unsealedTestEnvelope('mc-save/test/idb', 1, payload)

const layerFor = (factory: IdbFactory, databaseName = DATABASE) =>
  indexedDbStorageLayer({ factory, databaseName })

/** A fresh medium per run, which is what isolation means for a real adapter. */
const freshLayer = () => layerFor(makeFakeIndexedDb())

/**
 * Fire a surface callback typed `(event: never) => void` (indexeddb-surface.ts:
 * no handler here reads its event argument, so `never` is the only value that
 * can occupy the position — mirrors fake-indexeddb.ts's identical helper).
 */
const fire = (handler: ((event: never) => void) | null | undefined): void => {
  if (handler === null || handler === undefined) return
  // @ts-expect-error -- nothing has type `never`; `undefined` stands in for a
  // callback whose signature intentionally admits no real argument.
  handler(undefined)
}

/** Narrows a raw stored record to the shape `seq` assertions need, without assuming it. */
const hasNumericSeq = (value: unknown): value is { readonly seq: number } =>
  typeof value === 'object' && value !== null && 'seq' in value && typeof value.seq === 'number'

// ---------------------------------------------------------------------------
// The promise `domain/storage-port.ts` made, kept
// ---------------------------------------------------------------------------

storagePortContract('IndexedDB', freshLayer)


// ---------------------------------------------------------------------------
// Insertion order: the claim a medium-backed adapter does not get for free
// ---------------------------------------------------------------------------

describe('insertion order survives the medium', () => {
  effect('keys answers in insertion order, NOT in ascending key order', () =>
    Effect.gen(function* () {
      // The contract block already asserts two keys. Four written in descending
      // alphabetical order is what tells the two orderings apart beyond doubt:
      // `getAllKeys()` on the store would answer a,b,c,d for any input.
      const storage = yield* StoragePort
      yield* storage.put(SaveKey('delta'), envelope({}))
      yield* storage.put(SaveKey('charlie'), envelope({}))
      yield* storage.put(SaveKey('bravo'), envelope({}))
      yield* storage.put(SaveKey('alpha'), envelope({}))

      expect(yield* storage.keys).toStrictEqual(['delta', 'charlie', 'bravo', 'alpha'])
    }).pipe(Effect.provide(freshLayer())),
  )

  effect('a re-written key keeps its original position, it does not move to the end', () =>
    Effect.gen(function* () {
      // `Map.set` gives the in-memory adapter this for nothing. IndexedDB gives
      // it nothing at all: a `put` that allocated a new sequence number would
      // silently reorder the world list every time a world was saved.
      const storage = yield* StoragePort
      yield* storage.put(SaveKey('first'), envelope({}))
      yield* storage.put(SaveKey('second'), envelope({}))
      yield* storage.put(SaveKey('first'), envelope({ again: true }))

      expect(yield* storage.keys).toStrictEqual(['first', 'second'])
    }).pipe(Effect.provide(freshLayer())),
  )

  effect('a deleted key does not hand its sequence number to the next writer', () =>
    Effect.gen(function* () {
      // The reason the next sequence number comes from the index's LARGEST
      // value rather than from the record count: after a delete the count is
      // one less than the high-water mark, so counting hands the freed number
      // to the next writer and two records end up sharing a sequence.
      //
      // The enumeration is asserted on the SEQUENCE NUMBERS and not only on the
      // order, deliberately. Two records with equal sequences still come back in
      // a plausible order — a stable sort leaves them in the order the store
      // happened to hold them — so an order-only assertion goes green on exactly
      // the bug it was written to catch, and only starts failing later, on a
      // machine whose iteration order differs. This is that test written so it
      // cannot do that.
      const factory = makeFakeIndexedDb()

      const keys = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(SaveKey('one'), envelope({}))
        yield* storage.put(SaveKey('two'), envelope({}))
        yield* storage.remove(SaveKey('one'))
        yield* storage.put(SaveKey('three'), envelope({}))
        return yield* storage.keys
      }).pipe(Effect.provide(layerFor(factory)))

      expect(keys).toStrictEqual(['two', 'three'])

      const sequences = (factory.recordsOf(DATABASE, SAVE_STORE_NAME) ?? []).map((record) => {
        if (!hasNumericSeq(record)) throw new Error('expected a stored record with a numeric seq')
        return record.seq
      })
      expect(new Set(sequences).size).toBe(sequences.length)
    }),
  )
})
// ---------------------------------------------------------------------------
// Error mapping. The channel is StorageError and stays StorageError.
// ---------------------------------------------------------------------------

describe('what the medium can do wrong, and what the caller is told', () => {
  effect('a quota failure is a StorageError the retry policy can recognise', () =>
    Effect.gen(function* () {
      // `domain/errors.ts` says the retry policy "belongs on top of this type
      // rather than inside it", and records what the reference's policy did:
      // `Schedule.exponential(100ms)`, 3 attempts, aborting on
      // `QuotaExceededError`. A policy can only abort on what it can see, so
      // this is the one distinction spelled into `operation`.
      const factory = makeFakeIndexedDb()
      factory.failNextWrite(QUOTA_EXCEEDED_ERROR)

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.put(A, envelope({})))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(isQuotaExceeded(error)).toBe(true)
      expect(error.key).toBe('alpha')
      expect(error.message).toContain('alpha')
    }),
  )

  effect('an ordinary DOMException is NOT reported as quota, so it stays retryable', () =>
    Effect.gen(function* () {
      // The half that matters more. Marking everything as quota would make the
      // policy give up on a transient failure and lose the player's save; the
      // marker has to be false for the common case.
      const factory = makeFakeIndexedDb()
      factory.failNextWrite('UnknownError', 'the medium hiccuped')

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.put(A, envelope({})))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(isQuotaExceeded(error)).toBe(false)
      expect(error.operation).toBe('indexeddb.put')
    }),
  )

  effect('a failure whose own `name` is not even a string is NOT reported as quota either', () =>
    Effect.gen(function* () {
      // `readString`'s own defensive re-check, one level more paranoid than
      // the test above: every `DOMException`-shaped cause this fake otherwise
      // produces already carries a STRING `name`, so this is the only way to
      // exercise the branch where it does not — a medium response malformed
      // enough that even reading its `name` is not something `failureFor` can
      // trust.
      const factory = makeFakeIndexedDb()
      factory.corruptNextWriteWithMalformedCause({ name: 42, message: 'not even a proper DOMException' })

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.put(A, envelope({})))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(isQuotaExceeded(error)).toBe(false)
      expect(error.operation).toBe('indexeddb.put')
    }),
  )

  effect('a failure whose `name` getter throws is NOT reported as quota either', () =>
    Effect.gen(function* () {
      const nameFailure = new Error('failure name could not be read')
      const malformedCause = Object.defineProperty({}, 'name', {
        get: () => {
          throw nameFailure
        },
      })
      const factory = makeFakeIndexedDb()
      factory.corruptNextWriteWithMalformedCause(malformedCause)

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.put(A, envelope({})))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(isQuotaExceeded(error)).toBe(false)
      expect(error.operation).toBe('indexeddb.put')
    }),
  )

  effect('a transaction that aborts fails the write AND leaves the store untouched', () =>
    Effect.gen(function* () {
      // A browser may abort a transaction of its own accord, with `error` null.
      // Two things must hold and the second is the one that is easy to miss: the
      // caller must be told, and the store must not have half a write in it.
      //
      // The abort is injected AFTER the write lands (`abortAfterNextWrite`), so
      // there is genuinely a half-done transaction to roll back. Aborting
      // earlier would leave the store unchanged for the trivial reason that
      // nothing had been written yet, and the second assertion would hold
      // against an adapter with no rollback at all.
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
        factory.abortAfterNextWrite()
        return yield* Effect.flip(storage.put(B, envelope({ n: 2 })))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.put')
      // Rolled back: `beta` never landed, and `alpha` is exactly as it was.
      expect((factory.recordsOf(DATABASE, SAVE_STORE_NAME) ?? []).length).toBe(1)
    }),
  )

  effect('preserves an undefined transaction cause without inventing one', () =>
    Effect.gen(function* () {
      // `error: undefined` is deliberately outside IdbTransaction's declared
      // `IdbDomException | null` — this test exists to prove runTransaction
      // does not invent a cause when the transaction reports none at all,
      // which is a stronger claim than "reports null". The cast below is
      // scoped to only this one out-of-contract field, not the object.
      // runTransaction calls `transaction.objectStore(...)` synchronously as
      // part of starting the transaction (src/domain/indexeddb-runtime.ts),
      // regardless of mode, so the call itself must succeed here. What this
      // test actually asserts nothing calls is any OPERATION on the returned
      // store: this path only ever runs the `start` callback below, which
      // ignores the store it is given and just schedules `onabort`.
      const unusedStore: IdbObjectStore = {
        indexNames: { length: 0, item: () => null, contains: () => false },
        get: () => {
          throw new Error('not expected to be called by this test')
        },
        put: () => {
          throw new Error('not expected to be called by this test')
        },
        delete: () => {
          throw new Error('not expected to be called by this test')
        },
        index: () => {
          throw new Error('not expected to be called by this test')
        },
        createIndex: () => {
          throw new Error('not expected to be called by this test')
        },
      }
      const transaction: {
        readonly objectStore: () => IdbObjectStore
        readonly abort: () => void
        readonly error: undefined
        oncomplete: ((event: never) => void) | null
        onerror: ((event: never) => void) | null
        onabort: ((event: never) => void) | null
      } = {
        objectStore: () => unusedStore,
        abort: () => undefined,
        error: undefined,
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const database: IdbDatabase = {
        name: DATABASE,
        version: 1,
        objectStoreNames: { length: 0, item: () => null, contains: () => false },
        createObjectStore: () => {
          throw new Error('not expected to be called by this test')
        },
        transaction: (): IdbTransaction => {
          // @ts-expect-error -- transaction.error is deliberately `undefined`, outside
          // IdbTransaction's declared `IdbDomException | null` (see the comment above).
          return transaction
        },
        close: () => undefined,
        onversionchange: null,
      }

      const error = yield* Effect.flip(
        runTransaction(database, 'readonly', 'indexeddb.test', undefined, () => {
          queueMicrotask(() => fire(transaction.onabort))
        }),
      )

      expect(error.cause).toBeUndefined()
    }),
  )

  effect('commitBatch rolls back earlier writes when a later mutation fails', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      const invalid = unsealedEnvelope({ cannotClone: () => undefined })

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ original: true }))
        return yield* Effect.flip(
          storage.commitBatch([
            { _tag: 'Put', key: A, envelope: envelope({ overwritten: true }) },
            { _tag: 'Put', key: B, envelope: invalid },
          ]),
        )
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error.operation).toBe('indexeddb.commitBatch')
      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: envelope({ original: true }) },
      ])
    }),
  )

  effect('commitBatch and readBatch reject null and malformed runtime arrays', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      const malformedInputs: ReadonlyArray<unknown> = [null, [null], new Array<unknown>(1), [undefined]]

      const result = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ original: true }))

        for (const input of malformedInputs) {
          const commitError = yield* Effect.flip(applyUntrustedArgument(storage.commitBatch, storage, [input]))
          expect([commitError._tag, commitError.operation]).toStrictEqual([
            'StorageError',
            'indexeddb.commitBatch',
          ])
          const readError = yield* Effect.flip(applyUntrustedArgument(storage.readBatch, storage, [input]))
          expect([readError._tag, readError.operation]).toStrictEqual([
            'StorageError',
            'indexeddb.readBatch',
          ])
        }

        return factory.recordsOf(DATABASE, SAVE_STORE_NAME)
      }).pipe(Effect.provide(layerFor(factory)))

      expect(result).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: envelope({ original: true }) },
      ])
    }),
  )

  effect('rejects hostile array shapes instead of reading them as an empty batch', () =>
    Effect.gen(function* () {
      let accessorRead = false
      const symbolOnly = new Array<unknown>(1)
      Object.defineProperty(symbolOnly, Symbol('extra'), { value: 'not an index', enumerable: true })
      const negativeIndex = new Array<unknown>(1)
      Object.defineProperty(negativeIndex, '-1', { value: 'not an index', enumerable: true })
      const accessorEntry = new Array<unknown>(1)
      Object.defineProperty(accessorEntry, '0', {
        get: () => {
          accessorRead = true
          return 'not a data entry'
        },
        enumerable: true,
      })
      const invalidLength = new Proxy([], {
        getOwnPropertyDescriptor: (target, property) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
          if (property === 'length' && descriptor !== undefined) {
            return { ...descriptor, value: Number.NaN }
          }
          return descriptor
        },
      })
      const unreadableShape = new Proxy([], {
        ownKeys: () => {
          throw new Error('batch keys could not be read')
        },
      })
      const malformedInputs: ReadonlyArray<unknown> = [
        symbolOnly,
        negativeIndex,
        accessorEntry,
        invalidLength,
        unreadableShape,
      ]

      const factory = makeFakeIndexedDb()
      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        for (const input of malformedInputs) {
          const commitError = yield* Effect.flip(applyUntrustedArgument(storage.commitBatch, storage, [input]))
          expect(commitError).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.commitBatch' })
          const readError = yield* Effect.flip(applyUntrustedArgument(storage.readBatch, storage, [input]))
          expect(readError).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.readBatch' })
        }
        expect(yield* storage.keys).toStrictEqual([])
      }).pipe(Effect.provide(layerFor(factory)))

      expect(accessorRead).toBe(false)
    }),
  )

  effect('rejects a blank SaveKey in readBatch instead of returning Option.none', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const result = yield* Effect.result(
        applyUntrustedArgument(storage.readBatch, storage, [['']]),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.readBatch' })
      }
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(freshLayer())),
  )

  effect('commitBatch reports a browser abort and rolls the whole checkpoint back', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        factory.abortAfterNextWrite()
        return yield* Effect.flip(
          storage.commitBatch([
            { _tag: 'Put', key: A, envelope: envelope({ n: 1 }) },
            { _tag: 'Put', key: B, envelope: envelope({ n: 2 }) },
          ]),
        )
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error.operation).toBe('indexeddb.commitBatch')
      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([])
    }),
  )

  effect('opening below the version already on disk fails, rather than silently downgrading', () =>
    Effect.gen(function* () {
      // `request.onerror` on the OPEN request itself (distinct from
      // `onblocked`): the DOM's `VersionError`, fired when the requested
      // version is lower than what is already stored. Not reachable through
      // `makeIndexedDbStorage`, which always asks for its own fixed
      // `STORE_LAYOUT_VERSION` — this is what a corrupted or hand-edited
      // record of "what version we last wrote" would look like.
      const factory = makeFakeIndexedDb()
      factory.holdOpenAt(DATABASE, STORE_LAYOUT_VERSION + 1)

      const error = yield* Effect.flip(
        Effect.gen(function* () {
          yield* StoragePort
        }).pipe(Effect.provide(layerFor(factory))),
      )

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.open')
    }),
  )

  effect('rejects an invalid database name before opening the factory', () =>
    Effect.gen(function* () {
      let openCalls = 0
      const error = yield* Effect.flip(
        applyUntrustedArgument(openDatabase, undefined, [{
          databaseName: '',
          factory: {
            open: () => {
              openCalls += 1
              throw new Error('factory must not receive an invalid database name')
            },
          },
        }]),
      )

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.open')
      expect(openCalls).toBe(0)
    }),
  )

  effect('rejects an unbranded key before starting an IndexedDB operation', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      const outcome = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        const error = yield* Effect.flip(applyUntrustedArgument(storage.get, storage, [null]))
        return { error, keys: yield* storage.keys }
      }).pipe(Effect.provide(layerFor(factory)))

      expect(outcome.error).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.transaction' })
      expect(outcome.keys).toStrictEqual([])
    }),
  )

  effect('maps a synchronous factory.open failure to StorageError', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        openDatabase({
          databaseName: DATABASE,
          factory: {
            open: () => {
              throw domException('InvalidStateError', 'open is unavailable')
            },
          },
        }),
      )

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.open')
      expect(error.key).toBe(DATABASE)
    }),
  )

  effect('maps an unavailable upgrade transaction to StorageError', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        openDatabase({
          databaseName: DATABASE,
          factory: {
            open: () => {
              const names: IdbStringList = {
                length: 1,
                contains: (name) => name === SAVE_STORE_NAME,
                item: (index) => (index === 0 ? SAVE_STORE_NAME : null),
              }
              const database: IdbDatabase = {
                name: DATABASE,
                version: STORE_LAYOUT_VERSION - 1,
                objectStoreNames: names,
                createObjectStore: () => {
                  throw new Error('the existing store should be selected')
                },
                transaction: () => {
                  throw new Error('the upgrade transaction is intentionally absent')
                },
                close: () => undefined,
                onversionchange: null,
              }
              let failure: IdbDomException | null = null
              const request: IdbOpenRequest = {
                result: database,
                get error() {
                  return failure
                },
                transaction: null,
                onsuccess: null,
                onerror: null,
                onupgradeneeded: null,
                onblocked: null,
              }
              queueMicrotask(() => {
                try {
                  fire(request.onupgradeneeded)
                  fire(request.onsuccess)
                } catch {
                  failure = domException('AbortError', 'the upgrade transaction was unavailable')
                  fire(request.onerror)
                }
              })
              return request
            },
          },
        }),
      )

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.open')
      expect(error.key).toBe(DATABASE)
    }),
  )

  effect('maps an upgrade callback exception and settles even when abort also throws', () =>
    Effect.gen(function* () {
      const openWithAbort = (abort: () => void) =>
        openDatabase({
          databaseName: makeIdbDatabaseName(`${DATABASE}/upgrade-failure`),
          factory: {
            open: () => {
              const names: IdbStringList = {
                length: 0,
                contains: () => false,
                item: () => null,
              }
              const transaction: IdbTransaction = {
                objectStore: () => {
                  throw new Error('the object store should not be read')
                },
                abort,
                error: null,
                oncomplete: null,
                onerror: null,
                onabort: null,
              }
              const database: IdbDatabase = {
                name: DATABASE,
                version: STORE_LAYOUT_VERSION - 1,
                objectStoreNames: names,
                createObjectStore: () => {
                  throw new Error('the upgrade callback failed')
                },
                transaction: () => transaction,
                close: () => undefined,
                onversionchange: null,
              }
              const request: IdbOpenRequest = {
                result: database,
                error: null,
                transaction,
                onsuccess: null,
                onerror: null,
                onupgradeneeded: null,
                onblocked: null,
              }
              queueMicrotask(() => {
                fire(request.onupgradeneeded)
                fire(request.onsuccess)
              })
              return request
            },
          },
        })

      const successfulAbort = yield* Effect.flip(openWithAbort(() => undefined))
      const throwingAbort = yield* Effect.flip(
        openWithAbort(() => {
          throw new Error('abort itself failed')
        }),
      )

      expect(successfulAbort._tag).toBe('StorageError')
      expect(successfulAbort.operation).toBe('indexeddb.open')
      expect(throwingAbort._tag).toBe('StorageError')
      expect(throwingAbort.operation).toBe('indexeddb.open')
      expect(throwingAbort.cause).toBeInstanceOf(Error)
      if (!(throwingAbort.cause instanceof Error)) throw new Error('unreachable: assertion above already failed')
      expect(throwingAbort.cause.message).toBe('the upgrade callback failed')
    }),
  )

  effect('a live connection closes itself on versionchange, so a later open does not block', () =>
    Effect.gen(function* () {
      // The other half of the `onblocked` test below, and the reason the
      // adapter registers `database.onversionchange` at all (this file's own
      // header: "Without this, THIS connection is what makes the next version
      // of the game fire `onblocked` in another tab"). Kept open across a
      // second, higher-version open — issued directly through `factory.open`,
      // since this adapter always requests its own fixed
      // `STORE_LAYOUT_VERSION` and a real version bump is what is being
      // simulated here, the way a second tab running a newer release would.
      const factory = makeFakeIndexedDb()
      const scope = yield* Scope.make()
      const first = yield* makeIndexedDbStorage({ factory, databaseName: DATABASE }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* first.put(A, envelope({ n: 1 }))

      const outcome = yield* Effect.callback<'success' | 'blocked' | 'error'>((resume) => {
        const request = factory.open(DATABASE, makeIdbVersion(STORE_LAYOUT_VERSION + 1))
        request.onupgradeneeded = () => undefined
        request.onsuccess = () => {
          resume(Effect.succeed('success'))
        }
        request.onblocked = () => {
          resume(Effect.succeed('blocked'))
        }
        request.onerror = () => {
          resume(Effect.succeed('error'))
        }
      })

      // Had `onversionchange` not closed the first connection, this comes
      // back 'blocked' instead — exactly the failure this handler exists to
      // prevent.
      expect(outcome).toBe('success')

      yield* Scope.close(scope, Exit.void)
    }),
  )

  effect('a blocked open is not dead — it retries and succeeds once the blocker closes', () =>
    Effect.gen(function* () {
      // The real DOM does not drop a `blocked` request; it stays pending and
      // can still fire `upgradeneeded`/`success` later, once whatever was in
      // the way leaves. Opened directly through `factory.open` — an
      // uncooperative connection with no `onversionchange` handler, the same
      // shape `holdOpenAt` models but closed explicitly here instead of never,
      // so the SAME request reports twice: `blocked`, then `success`.
      const factory = makeFakeIndexedDb()

      const first = yield* Effect.callback<IdbDatabase>((resume) => {
        const request = factory.open(DATABASE, STORE_LAYOUT_VERSION)
        request.onupgradeneeded = () => undefined
        request.onsuccess = () => {
          resume(Effect.succeed(request.result))
        }
      })

      const reports: Array<'blocked' | 'success'> = []
      const second = yield* Effect.callback<'success'>((resume) => {
        const request = factory.open(DATABASE, makeIdbVersion(STORE_LAYOUT_VERSION + 1))
        request.onupgradeneeded = () => undefined
        request.onblocked = () => {
          reports.push('blocked')
          // Close only now — after `blocked` actually reported — so this
          // proves the retry path rather than a request that never blocked.
          first.close()
        }
        request.onsuccess = () => {
          reports.push('success')
          resume(Effect.succeed('success'))
        }
      })

      expect(reports).toStrictEqual(['blocked', 'success'])
      expect(second).toBe('success')
    }),
  )

  effect('a late second report, after the adapter already settled on blocked, is silently dropped', () =>
    Effect.gen(function* () {
      // The adapter's own `openDatabase` (`domain/indexeddb-storage.ts`) has
      // the identical "already settled" guard as `runTransaction`, and this is
      // what it is for: the underlying open request from the previous test
      // can genuinely report twice, but `StoragePort`'s Effect must resolve
      // exactly once. Here the FIRST report is what the layer resolves with —
      // a blocked failure — and the second (a later, unrequested success) must
      // change nothing about that.
      const factory = makeFakeIndexedDb()

      // A live connection below `STORE_LAYOUT_VERSION`, opened directly and
      // with no `onversionchange` handler, so the adapter's own open — always
      // for `STORE_LAYOUT_VERSION` — is genuinely blocked rather than won
      // outright.
      const blocker = yield* Effect.callback<IdbDatabase>((resume) => {
        const request = factory.open(DATABASE, makeIdbVersion(1))
        request.onupgradeneeded = () => undefined
        request.onsuccess = () => {
          resume(Effect.succeed(request.result))
        }
      })

      let adapterRequest: IdbOpenRequest | undefined
      const adapterFactory: IdbFactory = {
        open: (name, version) => {
          const request = factory.open(name, version)
          adapterRequest = request
          return request
        },
      }

      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          yield* StoragePort
        }).pipe(Effect.provide(layerFor(adapterFactory))),
      )
      expect(Exit.isFailure(outcome)).toBe(true)

      // A native request can report another failure after `onblocked`; the
      // adapter must still deliver its Effect only once.
      fire(adapterRequest?.onerror)

      // The adapter's Effect has already resolved with the failure above.
      // Closing the blocker now retries the SAME underlying request, which
      // this time succeeds — a second report the adapter must not act on.
      // Nothing further to assert on the (already-completed) Effect; the
      // claim is only that this does not throw or hang.
      blocker.close()
      yield* Effect.sleep('0 millis')
    }),
  )

  effect('a blocked upgrade fails rather than waiting forever', () =>
    Effect.gen(function* () {
      // The DOM does not treat `blocked` as an error: the open stays pending
      // until the other connection closes, possibly never. Waiting is the worse
      // failure — a title screen that never loads and no message anywhere. The
      // operation names it so a bug report can tell it from a real open failure.
      // A holder at a version BELOW ours is what blocks, because our open is
      // then an upgrade and an upgrade cannot run while anyone else is
      // connected.
      const factory = makeFakeIndexedDb()
      factory.holdOpenAt(DATABASE, STORE_LAYOUT_VERSION - 1)

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* StoragePort
        }).pipe(Effect.provide(layerFor(factory))),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          yield* StoragePort
        }).pipe(Effect.provide(layerFor(factory))),
      )
      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.open:blocked')
    }),
  )

  effect('a record this adapter did not write is an error, never a silent none', () =>
    Effect.gen(function* () {
      // `none` means "new world" everywhere up the stack
      // (`domain/persistence.ts`), and `test/binary-roundtrip.test.ts` states
      // what that costs: a save that reports itself absent "does not read as an
      // error anywhere up the stack — it reads as fresh terrain". So a present
      // but unrecognisable record must be loud.
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        {
          key: 'alpha',
          seq: 0,
          envelope: { format: 'mc-save/test/idb', version: 1, payload: { n: 1 }, unexpected: true },
        },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.get(A))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.get')
    }),
  )

  effect('a malformed record makes compare-and-set fail with the decode cause', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        {
          key: 'alpha',
          seq: 0,
          envelope: { format: 'mc-save/test/idb', version: 1, payload: { n: 1 }, unexpected: true },
        },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(
          storage.commitBatch([
            { _tag: 'Remove', key: A, expected: Option.some(envelope({ n: 1 })) },
          ]),
        )
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.commitBatch')
      expect(error.key).toBe('alpha')
      expect(error.cause).toMatchObject({ _tag: 'SaveDecodeError' })
      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toHaveLength(1)
    }),
  )

  effect('readBatch is just as loud about a record this adapter did not write', () =>
    Effect.gen(function* () {
      // `readBatch` has its own copy of the same "present but unrecognisable"
      // check `get` has, on its own separate code path — the two are not
      // implemented in terms of each other, so `get`'s coverage of this does
      // not stand in for `readBatch`'s.
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        { key: 'alpha', seq: 0, envelope: envelope({ n: 1 }) },
        { key: 'beta', seq: 1, somethingElse: 'not an envelope' },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.readBatch([A, B]))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.readBatch')
    }),
  )

  effect('a record present under our key but carrying no string key of its own is an error too', () =>
    Effect.gen(function* () {
      // `readEnvelope`'s FIRST guard, ahead of and distinct from the
      // "no `envelope` field" case above: real IndexedDB's `keyPath` only
      // requires SOME value at the key path, not a string one, so a foreign
      // writer could leave a record IndexedDB happily stores and returns for
      // `get('alpha')` whose own `key` field is missing or not a string —
      // `seedAt` is what makes that constructible at all (`seed` itself
      // can't, see its doc comment).
      const factory = makeFakeIndexedDb()
      factory.seedAt(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        { key: 'alpha', value: { seq: 0, envelope: { format: 'mc-save/test/idb', version: 1, payload: { n: 1 } } } },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.get(A))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.get')
    }),
  )

  effect('an envelope with unknown keys is rejected before get returns it', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        {
          key: 'alpha',
          seq: 0,
          envelope: {
            format: 'mc-save/test/idb',
            version: 1,
            payload: { n: 1 },
            unknown: 'not allowed',
          },
        },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.get(A))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.get')
    }),
  )

  effect('invalid envelope fields are rejected before get returns them', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        {
          key: 'alpha',
          seq: 0,
          envelope: {
            format: '',
            version: 0,
            payload: { n: 1 },
            integrity: {
              algorithm: 'fnv1a32',
              byteLength: -1,
              checksum: 'not-a-checksum',
            },
          },
        },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.get(A))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.get')
    }),
  )

  effect('an envelope without payload is rejected before get returns it', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        {
          key: 'alpha',
          seq: 0,
          envelope: {
            format: 'mc-save/test/idb',
            version: 1,
          },
        },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.get(A))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.get')
    }),
  )

  effect('a strict envelope failure aborts readBatch', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        { key: 'alpha', seq: 0, envelope: { format: 'mc-save/test/idb', version: 1, payload: { n: 1 } } },
        {
          key: 'beta',
          seq: 1,
          envelope: {
            format: 'mc-save/test/idb',
            version: 1,
            payload: { n: 2 },
            unknown: 'not allowed',
          },
        },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.readBatch([A, B]))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.readBatch')
    }),
  )

  effect('a malformed index answer (not an array) fails keys as a StorageError', () =>
    Effect.gen(function* () {
      // Nothing reachable through `put`/`seed` can make the index answer
      // anything but a well-formed array of string keys — see
      // `corruptNextIndexKeys`'s own doc comment. `readKeys` returns a typed
      // validation failure, and `runTransaction` aborts before reporting the
      // resulting `StorageError`.
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
        factory.corruptNextIndexKeys('not-an-array')
        return yield* Effect.flip(storage.keys)
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.keys')
      expect(error.cause).toBe(`${INSERTION_INDEX_NAME} did not return a list of keys`)
    }),
  )

  effect('a malformed index answer (a non-string entry) fails keys as a StorageError', () =>
    Effect.gen(function* () {
      // `readKeys` rejects arrays with entries that are not strings.
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
        factory.corruptNextIndexKeys(['alpha', 123])
        return yield* Effect.flip(storage.keys)
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.keys')
      expect(error.cause).toBe(`${SAVE_STORE_NAME} returned a non-string key`)
    }),
  )

  effect('reports the ORIGINAL failure, not a secondary one, when the abort that follows it also fails', () =>
    Effect.gen(function* () {
      // `guard`'s own catch (`domain/indexeddb-storage.ts`): when the body
      // that processes a request's result throws, the transaction is aborted
      // as well as reported — and if THAT abort call itself fails (a medium
      // failure this adapter cannot cause through legitimate use, hence
      // `corruptNextAbort`), the caller must still see the failure that
      // actually broke the chain, not a `TransactionInactiveError` about
      // failing to clean up after it.
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
        factory.corruptNextIndexKeys('not-an-array')
        factory.corruptNextAbort(domException('InvalidStateError', 'the transaction has already finished'))
        return yield* Effect.flip(storage.keys)
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.keys')
      expect(error.cause).toBe(`${INSERTION_INDEX_NAME} did not return a list of keys`)
    }),
  )

  effect('a request-level failure is still reported when aborting after it also fails', () =>
    Effect.gen(function* () {
      // `onResult`'s own onerror handler has the identical fallback, one level
      // closer to the medium: the request itself failed (`failNextWrite`), and
      // the abort that follows fails too. `commitBatch`'s writes are the ones
      // to use here — unlike `put`'s own last write, every write inside
      // `commitBatch` is wrapped through `onResult`, so its request-level
      // `onerror` is the one that actually fires.
      const factory = makeFakeIndexedDb()
      factory.failNextWrite('UnknownError', 'the medium hiccuped')
      factory.corruptNextAbort(domException('InvalidStateError', 'the transaction has already finished'))

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.commitBatch([{ _tag: 'Put', key: A, envelope: envelope({}) }]))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.commitBatch')
      expect(isQuotaExceeded(error)).toBe(false)
    }),
  )

  effect('rejects malformed stored sequence records before replacing them', () =>
    Effect.gen(function* () {
      const malformedValues: ReadonlyArray<unknown> = [
        [],
        { key: 'alpha' },
        { key: 'alpha', seq: 'zero' },
        { key: 'alpha', seq: -1 },
      ]

      for (const value of malformedValues) {
        const factory = makeFakeIndexedDb()
        factory.seedAt(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [{ key: 'alpha', value }])

        const error = yield* Effect.gen(function* () {
          const storage = yield* StoragePort
          return yield* Effect.flip(storage.put(A, envelope({ n: 2 })))
        }).pipe(Effect.provide(layerFor(factory)))

        expect(error._tag).toBe('StorageError')
        expect(error.operation).toBe('indexeddb.sequence')
        expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([value])
      }
    }),
  )

  effect('parses unknown IndexedDB records through typed failures', () =>
    Effect.sync(() => {
      expect(Result.isFailure(readSequence([]))).toBe(true)
      expect(Result.isFailure(readSequence({}))).toBe(true)
      expect(readSequence(undefined)).toStrictEqual(Result.succeed(undefined))
      expect(readSequence({ seq: 0 })).toStrictEqual(Result.succeed(0))

      const recordFailure = new Error('record fields failed')
      const unreadableRecord = Object.defineProperty({}, 'key', {
        enumerable: true,
        get: () => { throw recordFailure },
      })
      const record = readEnvelope(unreadableRecord)
      expect(Result.isFailure(record)).toBe(true)
      if (Result.isFailure(record)) {
        expect(record.failure._tag).toBe('SaveDecodeError')
        expect(record.failure.cause).toBe(recordFailure)
      }
      expect(Result.isFailure(readEnvelope(null))).toBe(true)
      expect(Result.isFailure(readEnvelope({ key: '', envelope: envelope({ n: 1 }) }))).toBe(true)
      expect(Result.isFailure(readEnvelope({ key: 'alpha', envelope: { format: 'bad' } }))).toBe(true)
      const sealed = envelope({ n: 1 })
      const malformedChecksum = {
        ...sealed,
        integrity: { ...sealed.integrity, checksum: 'bad' },
      }
      expect(Result.isFailure(readEnvelope({ key: 'alpha', envelope: malformedChecksum }))).toBe(true)

      const decodeFailure = new Error('envelope fields failed')
      const unreadableEnvelope = new Proxy(envelope({ n: 1 }), {
        get: (target, property, receiver) => {
          if (property === 'format') throw decodeFailure
          return Reflect.get(target, property, receiver)
        },
      })
      const envelopeResult = readEnvelope({ key: 'alpha', envelope: unreadableEnvelope })
      expect(Result.isFailure(envelopeResult)).toBe(true)
      if (Result.isFailure(envelopeResult)) {
        expect(envelopeResult.failure._tag).toBe('SaveDecodeError')
        expect(envelopeResult.failure.reason).toBe('stored save envelope could not be read')
        expect(envelopeResult.failure.cause).toBeInstanceOf(Error)
      }

      expect(Result.isFailure(readKeys(['']))).toBe(true)
    }),
  )

  effect('rejects sequence allocation beyond the safe integer range', () =>
    Effect.gen(function* () {
      for (const operation of ['put', 'commitBatch'] as const) {
        const factory = makeFakeIndexedDb()
        const existing = { key: 'alpha', seq: Number.MAX_SAFE_INTEGER, envelope: envelope({ n: 1 }) }
        factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [existing])

        const error = yield* Effect.gen(function* () {
          const storage = yield* StoragePort
          const write = operation === 'put'
            ? storage.put(B, envelope({ n: 2 }))
            : storage.commitBatch([{ _tag: 'Put', key: B, envelope: envelope({ n: 2 }) }])
          return yield* Effect.flip(write)
        }).pipe(Effect.provide(layerFor(factory)))

        expect(error).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.sequence' })
        expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([existing])
      }
    }),
  )

  effect('rejects malformed indexed sequences in cursor and existing-record paths', () =>
    Effect.gen(function* () {
      for (const operation of ['put', 'commitBatch'] as const) {
        const factory = makeFakeIndexedDb()
        factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
          { key: 'alpha', seq: 'zero', envelope: envelope({ n: 1 }) },
        ])

        const error = yield* Effect.gen(function* () {
          const storage = yield* StoragePort
          const write = operation === 'put'
            ? storage.put(B, envelope({ n: 2 }))
            : storage.commitBatch([{ _tag: 'Put', key: B, envelope: envelope({ n: 2 }) }])
          return yield* Effect.flip(write)
        }).pipe(Effect.provide(layerFor(factory)))

        expect(error._tag).toBe('StorageError')
        expect(error.operation).toBe('indexeddb.sequence')
        expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([
          { key: 'alpha', seq: 'zero', envelope: envelope({ n: 1 }) },
        ])
      }

      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        { key: 'alpha', envelope: envelope({ n: 1 }) },
      ])
      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(
          storage.commitBatch([{ _tag: 'Put', key: A, envelope: envelope({ n: 2 }) }]),
        )
      }).pipe(Effect.provide(layerFor(factory)))
      expect(error.operation).toBe('indexeddb.sequence')
    }),
  )

  effect('fails closed when the insertion cursor is malformed or unreadable', () =>
    Effect.gen(function* () {
      const cursorFailure = new Error('cursor key could not be read')
      const unreadableCursor = Object.defineProperty({}, 'key', {
        get: () => {
          throw cursorFailure
        },
      })

      for (const cursor of [42, unreadableCursor]) {
        const factory = makeFakeIndexedDb()
        factory.corruptNextCursor(cursor)
        const error = yield* Effect.gen(function* () {
          const storage = yield* StoragePort
          return yield* Effect.flip(storage.put(A, envelope({ value: true })))
        }).pipe(Effect.provide(layerFor(factory)))

        expect(error).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.sequence' })
        if (cursor === unreadableCursor) expect(error.cause).toBe(cursorFailure)
        expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([])
      }
    }),
  )

  effect('maps thrown save envelope decoding to StorageError', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      const decodeFailure = new Error('envelope could not be decoded')
      const unreadableEnvelope = new Proxy(envelope({ value: true }), {
        get: (target, property, receiver) => {
          if (property === 'format') throw decodeFailure
          return Reflect.get(target, property, receiver)
        },
      })
      const outcome = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        const result = yield* Effect.result(applyUntrustedArgument(storage.put, storage, [A, unreadableEnvelope]))
        return { result, records: factory.recordsOf(DATABASE, SAVE_STORE_NAME) }
      }).pipe(Effect.provide(layerFor(factory)))

      expect(Result.isFailure(outcome.result)).toBe(true)
      if (Result.isFailure(outcome.result)) {
        expect(outcome.result.failure).toMatchObject({
          _tag: 'StorageError',
          operation: 'indexeddb.put',
          key: A,
        })
        const cause = outcome.result.failure.cause
        expect(cause).toBeInstanceOf(Error)
        if (cause instanceof Error) {
          expect(cause.message).toBe('Result adapter can only return schema issues')
        }
      }
      expect(outcome.records).toStrictEqual([])
    }),
  )

  effect('returns none for missing records and detects expected-value conflicts', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      expect(yield* storage.get(A)).toStrictEqual(Option.none())

      const conflict = yield* Effect.flip(storage.commitBatch([
        { _tag: 'Put', key: A, envelope: envelope({ n: 2 }), expected: Option.some(envelope({ n: 1 })) },
      ]))
      expect(conflict.operation).toBe('indexeddb.commitBatch:conflict')
      expect(conflict.key).toBe('alpha')
    }).pipe(Effect.provide(freshLayer())),
  )

  effect('a failed compare-and-remove leaves the current record intact', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      const outcome = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ current: true }))
        const error = yield* Effect.flip(storage.commitBatch([
          { _tag: 'Remove', key: A, expected: Option.some(envelope({ stale: true })) },
        ]))
        return { error, stored: yield* storage.get(A) }
      }).pipe(Effect.provide(layerFor(factory)))

      expect(outcome.error).toMatchObject({
        _tag: 'StorageError',
        operation: 'indexeddb.commitBatch:conflict',
        key: A,
      })
      expect(outcome.stored).toStrictEqual(Option.some(envelope({ current: true })))
    }),
  )

  effect('a compare-and-put preserves envelope decoding failures', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        { key: 'alpha', seq: 0, envelope: { format: 'invalid', version: 0 } },
      ])

      const outcome = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        const error = yield* Effect.flip(storage.commitBatch([
          { _tag: 'Put', key: A, envelope: envelope({ replacement: true }), expected: Option.some(envelope({ stale: true })) },
        ]))
        return { error, records: factory.recordsOf(DATABASE, SAVE_STORE_NAME) }
      }).pipe(Effect.provide(layerFor(factory)))

      expect(outcome.error).toMatchObject({
        _tag: 'StorageError',
        operation: 'indexeddb.commitBatch',
        key: A,
        cause: { _tag: 'SaveDecodeError' },
      })
      expect(outcome.records).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: { format: 'invalid', version: 0 } },
      ])
    }),
  )

  effect('rejects malformed mutations without corrupting records', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      const outcome = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        const nullExpected = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
          { _tag: 'Put', key: A, envelope: envelope({ replacement: true }), expected: null },
        ]]))
        const undefinedExpected = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
          { _tag: 'Put', key: A, envelope: envelope({ replacement: true }), expected: undefined },
        ]]))
        const invalidEnvelope = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
          { _tag: 'Put', key: A, envelope: null },
        ]]))
        const invalidPut = yield* Effect.result(applyUntrustedArgument(storage.put, storage, [A, null]))
        const afterNullExpected = yield* Effect.result(storage.get(A))
        const afterInvalidPut = yield* Effect.result(storage.get(A))

        yield* storage.put(A, envelope({ original: true }))
        const unknownTag = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
          { _tag: 'Rename', key: A },
        ]]))
        const malformedEntry = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[42]]))
        const blankKey = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
          { _tag: 'Put', key: '', envelope: envelope({ replacement: true }) },
        ]]))
        const tagFailure = new Error('mutation tag could not be read')
        const unreadableTag = Object.defineProperty({}, '_tag', {
          get: () => {
            throw tagFailure
          },
        })
        const unreadableMutation = yield* Effect.result(
          applyUntrustedArgument(storage.commitBatch, storage, [[unreadableTag]]),
        )
        const afterUnknownTag = yield* Effect.result(storage.get(A))
        const afterMalformed = yield* Effect.result(storage.get(A))
        return {
          nullExpected,
          undefinedExpected,
          invalidEnvelope,
          invalidPut,
          afterNullExpected,
          afterInvalidPut,
          unknownTag,
          malformedEntry,
          blankKey,
          unreadableMutation,
          tagFailure,
          afterUnknownTag,
          afterMalformed,
        }
      }).pipe(Effect.provide(layerFor(factory)))

      for (const result of [
        outcome.nullExpected,
        outcome.undefinedExpected,
        outcome.invalidEnvelope,
        outcome.unknownTag,
        outcome.malformedEntry,
        outcome.blankKey,
        outcome.unreadableMutation,
      ]) {
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.commitBatch' })
        }
      }
      if (Result.isFailure(outcome.invalidPut)) {
        expect(outcome.invalidPut.failure).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.put' })
      }
      if (Result.isFailure(outcome.invalidEnvelope)) {
        expect(outcome.invalidEnvelope.failure).toMatchObject({ _tag: 'StorageError', operation: 'indexeddb.commitBatch' })
      }
      if (Result.isFailure(outcome.unreadableMutation)) {
        expect(outcome.unreadableMutation.failure.cause).toBe(outcome.tagFailure)
      }
      expect(outcome.afterNullExpected).toStrictEqual(Result.succeed(Option.none()))
      expect(outcome.afterInvalidPut).toStrictEqual(Result.succeed(Option.none()))
      expect(outcome.afterUnknownTag).toStrictEqual(Result.succeed(Option.some(envelope({ original: true }))))
      expect(outcome.afterMalformed).toStrictEqual(Result.succeed(Option.some(envelope({ original: true }))))
    }),
  )

  effect('uses each mutation field snapshot once when committing a batch', () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        let tagReads = 0
        const mutation = {
          get _tag(): 'Put' {
            tagReads += 1
            if (tagReads > 1) throw new Error('mutation tag was read more than once')
            return 'Put'
          },
          key: A,
          envelope: envelope({ snapshot: true }),
        }
        const result = yield* Effect.result(storage.commitBatch([mutation]))
        return { result, tagReads, stored: yield* storage.get(A) }
      }).pipe(Effect.provide(freshLayer()))

      expect(outcome.result).toStrictEqual(Result.succeed(undefined))
      expect(outcome.tagReads).toBe(1)
      expect(outcome.stored).toStrictEqual(Option.some(envelope({ snapshot: true })))
    }),
  )

  effect('rejects malformed envelope records and unreadable record properties', () =>
    Effect.gen(function* () {
      const unreadable = Object.defineProperty({}, 'key', {
        enumerable: true,
        get: () => {
          throw new Error('record key getter failed')
        },
      })
      const values: ReadonlyArray<unknown> = [
        null,
        { key: 42, seq: 0, envelope: envelope({ n: 1 }) },
        { key: '', seq: 0, envelope: envelope({ n: 1 }) },
        { key: 'alpha', seq: 0 },
        unreadable,
      ]

      for (const value of values) {
        const factory = makeFakeIndexedDb()
        factory.seedAt(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [{ key: 'alpha', value }])

        const error = yield* Effect.gen(function* () {
          const storage = yield* StoragePort
          return yield* Effect.flip(storage.get(A))
        }).pipe(Effect.provide(layerFor(factory)))

        expect(error._tag).toBe('StorageError')
        expect(error.operation).toBe('indexeddb.get')
      }
    }),
  )

  effect('rejects invalid and unreadable keys from the insertion index', () =>
    Effect.gen(function* () {
      const invalidLength = new Proxy([], {
        get: (target, property, receiver) =>
          property === 'length' ? -1 : Reflect.get(target, property, receiver),
      })
      const unreadableLength = new Proxy([], {
        get: (target, property, receiver) => {
          if (property === 'length') throw new Error('index length getter failed')
          return Reflect.get(target, property, receiver)
        },
      })
      const unreadableEntry = new Proxy(['alpha'], {
        get: (target, property, receiver) => {
          if (property === '0') throw new Error('index entry getter failed')
          return Reflect.get(target, property, receiver)
        },
      })
      const answers: ReadonlyArray<unknown> = ['', invalidLength, unreadableLength, unreadableEntry]

      for (const answer of answers) {
        const factory = makeFakeIndexedDb()
        const error = yield* Effect.gen(function* () {
          const storage = yield* StoragePort
          yield* storage.put(A, envelope({ n: 1 }))
          factory.corruptNextIndexKeys(answer)
          return yield* Effect.flip(storage.keys)
        }).pipe(Effect.provide(layerFor(factory)))

        expect(error._tag).toBe('StorageError')
        expect(error.operation).toBe('indexeddb.keys')
      }
    }),
  )

  effect('closes a late open success after the blocked error settles', () =>
    Effect.gen(function* () {
      let closes = 0
      const names: IdbStringList = { length: 0, contains: () => false, item: () => null }
      const database: IdbDatabase = {
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: names,
        createObjectStore: () => { throw new Error('not expected to create a store') },
        transaction: () => { throw new Error('not expected to start a transaction') },
        close: () => {
          closes += 1
          throw new Error('late database close failed')
        },
        onversionchange: null,
      }
      const request: IdbOpenRequest = {
        result: database,
        error: null,
        transaction: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      }
      const error = yield* Effect.flip(openDatabase({
        databaseName: DATABASE,
        factory: {
          open: () => {
            queueMicrotask(() => fire(request.onblocked))
            queueMicrotask(() => fire(request.onsuccess))
            return request
          },
        },
      }))

      expect(error.operation).toBe('indexeddb.open:blocked')
      yield* Effect.sleep('0 millis')
      expect(closes).toBe(1)
    }),
  )

  effect('ignores close failure from a live database version-change callback', () =>
    Effect.gen(function* () {
      const names: IdbStringList = { length: 0, contains: () => false, item: () => null }
      const database: IdbDatabase = {
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: names,
        createObjectStore: () => { throw new Error('not expected to create a store') },
        transaction: () => { throw new Error('not expected to start a transaction') },
        close: () => { throw new Error('close failed during version change') },
        onversionchange: null,
      }
      const request: IdbOpenRequest = {
        result: database,
        error: null,
        transaction: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      }
      queueMicrotask(() => fire(request.onsuccess))

      expect(yield* openDatabase({ databaseName: DATABASE, factory: { open: () => request } })).toBe(database)
      fire(database.onversionchange)
    }),
  )

  effect('maps a version-change handler setter failure and closes the database', () =>
    Effect.gen(function* () {
      const assignmentFailure = new Error('version-change handler could not be installed')
      let closes = 0
      const names: IdbStringList = { length: 0, contains: () => false, item: () => null }
      const database: IdbDatabase = {
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: names,
        createObjectStore: () => { throw new Error('not expected to create a store') },
        transaction: () => { throw new Error('not expected to start a transaction') },
        close: () => {
          closes += 1
          throw new Error('database close failed after handler registration failed')
        },
        get onversionchange() { return null },
        set onversionchange(_handler: ((event: never) => void) | null) { throw assignmentFailure },
      }
      const request: IdbOpenRequest = {
        result: database,
        error: null,
        transaction: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      }

      const error = yield* Effect.flip(openDatabase({
        databaseName: DATABASE,
        factory: {
          open: () => {
            queueMicrotask(() => fire(request.onsuccess))
            return request
          },
        },
      }))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.open')
      expect(error.cause).toBe(assignmentFailure)
      expect(closes).toBe(1)
    }),
  )

  effect('maps a request result getter failure to a typed open error', () =>
    Effect.gen(function* () {
      const resultFailure = new Error('request result could not be read')
      const request: IdbOpenRequest = {
        get result(): IdbDatabase {
          throw resultFailure
        },
        error: null,
        transaction: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      }
      queueMicrotask(() => fire(request.onsuccess))

      const error = yield* Effect.flip(
        openDatabase({
          databaseName: DATABASE,
          factory: { open: () => request },
        }),
      )

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.open')
      expect(error.cause).toBe(resultFailure)
    }),
  )

  effect('maps an open-request error getter failure to the typed storage error', () =>
    Effect.gen(function* () {
      const errorFailure = new Error('open request error could not be read')
      const names: IdbStringList = {
        length: 0,
        contains: () => false,
        item: () => null,
      }
      const database: IdbDatabase = {
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: names,
        createObjectStore: () => {
          throw new Error('not expected to create a store')
        },
        transaction: () => {
          throw new Error('not expected to start a transaction')
        },
        close: () => undefined,
        onversionchange: null,
      }
      const request: IdbOpenRequest = {
        result: database,
        get error(): IdbDomException | null {
          throw errorFailure
        },
        transaction: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      }
      queueMicrotask(() => fire(request.onerror))

      const error = yield* Effect.flip(
        openDatabase({
          databaseName: DATABASE,
          factory: { open: () => request },
        }),
      )

      expect(error.operation).toBe('indexeddb.open')
      expect(error.cause).toBe(errorFailure)
    }),
  )

  effect('closes a database when registering its version-change handler fails', () =>
    Effect.gen(function* () {
      const registrationFailure = new Error('version-change handler cannot be installed')
      let closed = false
      const names: IdbStringList = {
        length: 0,
        contains: () => false,
        item: () => null,
      }
      const database: IdbDatabase = {
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: names,
        createObjectStore: () => {
          throw new Error('not expected to create a store')
        },
        transaction: () => {
          throw new Error('not expected to start a transaction')
        },
        close: () => {
          closed = true
        },
        get onversionchange() {
          return null
        },
        set onversionchange(_handler) {
          throw registrationFailure
        },
      }
      const request: IdbOpenRequest = {
        result: database,
        error: null,
        transaction: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      }
      queueMicrotask(() => fire(request.onsuccess))

      const error = yield* Effect.flip(
        openDatabase({
          databaseName: DATABASE,
          factory: { open: () => request },
        }),
      )

      expect(error.operation).toBe('indexeddb.open')
      expect(error.cause).toBe(registrationFailure)
      expect(closed).toBe(true)
    }),
  )

  effect('fails when registering an open-request handler throws', () =>
    Effect.gen(function* () {
      const registrationFailure = new Error('blocked handler cannot be installed')
      const names: IdbStringList = {
        length: 0,
        contains: () => false,
        item: () => null,
      }
      const database: IdbDatabase = {
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: names,
        createObjectStore: () => {
          throw new Error('not expected to create a store')
        },
        transaction: () => {
          throw new Error('not expected to start a transaction')
        },
        close: () => undefined,
        onversionchange: null,
      }
      const request = {
        result: database,
        error: null,
        transaction: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        get onblocked() {
          return null
        },
        set onblocked(_handler: IdbOpenRequest['onblocked']) {
          throw registrationFailure
        },
      } satisfies IdbOpenRequest

      const error = yield* Effect.flip(
        openDatabase({
          databaseName: DATABASE,
          factory: { open: () => request },
        }),
      )

      expect(error.operation).toBe('indexeddb.open')
      expect(error.cause).toBe(registrationFailure)
    }),
  )

  effect('maps synchronous transaction setup failures and missing results to storage errors', () =>
    Effect.gen(function* () {
      const store: IdbObjectStore = {
        indexNames: { length: 0, contains: () => false, item: () => null },
        get: () => {
          throw new Error('unused')
        },
        put: () => {
          throw new Error('unused')
        },
        delete: () => {
          throw new Error('unused')
        },
        index: () => {
          throw new Error('unused')
        },
        createIndex: () => {
          throw new Error('unused')
        },
      }

      let callbackTransaction: IdbTransaction
      callbackTransaction = {
        objectStore: () => store,
        abort: () => queueMicrotask(() => fire(callbackTransaction.onabort)),
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const callbackDatabase: IdbDatabase = {
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: { length: 0, contains: () => false, item: () => null },
        createObjectStore: () => store,
        transaction: () => callbackTransaction,
        close: () => undefined,
        onversionchange: null,
      }
      const callbackFailure = new Error('transaction start failed')
      const callbackError = yield* Effect.flip(
        runTransaction(callbackDatabase, 'readwrite', 'indexeddb.test', SaveKey('alpha'), () => {
          throw callbackFailure
        }),
      )
      expect(callbackError.operation).toBe('indexeddb.test')
      expect(callbackError.cause).toBe(callbackFailure)

      let incompleteTransaction: IdbTransaction
      incompleteTransaction = {
        objectStore: () => store,
        abort: () => queueMicrotask(() => fire(incompleteTransaction.onabort)),
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const incompleteDatabase: IdbDatabase = {
        ...callbackDatabase,
        transaction: () => incompleteTransaction,
      }
      const incompleteError = yield* Effect.flip(
        runTransaction(incompleteDatabase, 'readonly', 'indexeddb.incomplete', undefined, () => {
          queueMicrotask(() => fire(incompleteTransaction.oncomplete))
        }),
      )
      expect(incompleteError.operation).toBe('indexeddb.incomplete:incomplete')

      const transactionFailure = new Error('transaction error event')
      let failingTransaction: IdbTransaction
      failingTransaction = {
        objectStore: () => store,
        abort: () => queueMicrotask(() => fire(failingTransaction.onabort)),
        error: transactionFailure,
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const failingDatabase: IdbDatabase = {
        ...callbackDatabase,
        transaction: () => failingTransaction,
      }
      const transactionError = yield* Effect.flip(
        runTransaction(failingDatabase, 'readwrite', 'indexeddb.onerror', undefined, () => {
          queueMicrotask(() => {
            fire(failingTransaction.onerror)
            fire(failingTransaction.onabort)
          })
        }),
      )
      expect(transactionError.cause).toBe(transactionFailure)

      const errorGetterFailure = new Error('transaction error getter failed')
      let unreadableTransaction: IdbTransaction
      unreadableTransaction = {
        objectStore: () => store,
        abort: () => queueMicrotask(() => fire(unreadableTransaction.onabort)),
        get error(): IdbDomException | null {
          throw errorGetterFailure
        },
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const unreadableDatabase: IdbDatabase = {
        ...callbackDatabase,
        transaction: () => unreadableTransaction,
      }
      const unreadableError = yield* Effect.flip(
        runTransaction(unreadableDatabase, 'readwrite', 'indexeddb.abort', undefined, () => {
          queueMicrotask(() => fire(unreadableTransaction.onabort))
        }),
      )
      expect(unreadableError.cause).toBe(errorGetterFailure)
    }),
  )

  effect('guards late transaction and request callbacks and captures unreadable errors', () =>
    Effect.gen(function* () {
      const names: IdbStringList = { length: 0, contains: () => false, item: () => null }
      const request = (result: unknown): IdbRequest => ({ result, error: null, onsuccess: null, onerror: null })
      const store: IdbObjectStore = {
        indexNames: names,
        get: () => request(undefined),
        put: () => request(undefined),
        delete: () => request(undefined),
        index: () => ({ getAllKeys: () => request([]), openCursor: () => request(null) }),
        createIndex: () => undefined,
      }
      const databaseFor = (transaction: IdbTransaction): IdbDatabase => ({
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: names,
        createObjectStore: () => store,
        transaction: () => transaction,
        close: () => undefined,
        onversionchange: null,
      })

      const transactionFailure = new Error('transaction error getter failed in onerror')
      let unreadableTransaction: IdbTransaction
      unreadableTransaction = {
        objectStore: () => store,
        abort: () => queueMicrotask(() => fire(unreadableTransaction.onabort)),
        get error(): IdbDomException | null { throw transactionFailure },
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const transactionError = yield* Effect.flip(runTransaction<never>(
        databaseFor(unreadableTransaction),
        'readwrite',
        'indexeddb.transaction-error',
        undefined,
        () => queueMicrotask(() => {
          fire(unreadableTransaction.onerror)
          fire(unreadableTransaction.onabort)
        }),
      ))
      expect(transactionError.cause).toBe(transactionFailure)

      let settledTransaction: IdbTransaction
      settledTransaction = {
        objectStore: () => store,
        abort: () => queueMicrotask(() => fire(settledTransaction.onabort)),
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const delivered = request('complete')
      const result = yield* runTransaction<string>(
        databaseFor(settledTransaction),
        'readwrite',
        'indexeddb.late-callback',
        undefined,
        (_activeStore, deliver, onResult, fail) => {
          onResult(delivered, (value) => {
            if (typeof value === 'string') deliver(value)
            else fail(value)
          })
          queueMicrotask(() => {
            fire(delivered.onsuccess)
            fire(settledTransaction.oncomplete)
            fail(new Error('failure arrived after completion'))
            fire(delivered.onerror)
          })
        },
      )
      expect(result).toBe('complete')

      const requestFailure = new Error('request error getter failed')
      let requestTransaction: IdbTransaction
      requestTransaction = {
        objectStore: () => store,
        abort: () => queueMicrotask(() => fire(requestTransaction.onabort)),
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const unreadableRequest: IdbRequest = {
        result: undefined,
        get error(): IdbDomException | null { throw requestFailure },
        onsuccess: null,
        onerror: null,
      }
      const requestError = yield* Effect.flip(runTransaction<never>(
        databaseFor(requestTransaction),
        'readwrite',
        'indexeddb.request-error',
        undefined,
        (_activeStore, _deliver, onResult) => {
          onResult(unreadableRequest, () => undefined)
          queueMicrotask(() => fire(unreadableRequest.onerror))
        },
      ))
      expect(requestError.cause).toBe(requestFailure)
    }),
  )

  effect('settles with the handler setup failure after an abort event', () =>
    Effect.gen(function* () {
      const store: IdbObjectStore = {
        indexNames: { length: 0, contains: () => false, item: () => null },
        get: () => {
          throw new Error('unused')
        },
        put: () => {
          throw new Error('unused')
        },
        delete: () => {
          throw new Error('unused')
        },
        index: () => {
          throw new Error('unused')
        },
        createIndex: () => {
          throw new Error('unused')
        },
      }
      const setupFailure = new Error('completion handler cannot be installed')
      let transaction: IdbTransaction
      transaction = {
        objectStore: () => store,
        abort: () => queueMicrotask(() => fire(transaction.onabort)),
        error: null,
        onerror: null,
        onabort: null,
        get oncomplete() {
          return null
        },
        set oncomplete(_handler) {
          throw setupFailure
        },
      }
      const database: IdbDatabase = {
        name: DATABASE,
        version: STORE_LAYOUT_VERSION,
        objectStoreNames: { length: 0, contains: () => false, item: () => null },
        createObjectStore: () => store,
        transaction: () => transaction,
        close: () => undefined,
        onversionchange: null,
      }

      const error = yield* Effect.flip(
        runTransaction(database, 'readonly', 'indexeddb.setup', undefined, () => undefined),
      )
      expect(error.operation).toBe('indexeddb.setup')
      expect(error.cause).toBe(setupFailure)
    }),
  )

  effect('operating on a closed connection is a StorageError, not a defect', () =>
    Effect.gen(function* () {
      // The state `onversionchange` deliberately creates: another tab is
      // upgrading, this connection closed itself, and the next write throws
      // `InvalidStateError` synchronously out of `transaction()`. A defect here
      // would crash the frame instead of reaching the save UI.
      const factory = makeFakeIndexedDb()

      const storage = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeIndexedDbStorage({ factory, databaseName: DATABASE })
          yield* service.put(A, envelope({}))
          return service
        }),
      )

      // The scope closed, so `close()` has run.
      const error = yield* Effect.flip(storage.put(B, envelope({})))
      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.put')
    }),
  )
})

// ---------------------------------------------------------------------------
// End to end through the toolkit, not just through the Port
// ---------------------------------------------------------------------------

describe('a save crosses the real seam', () => {
  effect('saveTo then loadFrom round-trips through a database', () =>
    Effect.gen(function* () {
      // Every other test here drives `StoragePort` directly. This one goes
      // through the codec, which is the path the game actually takes, and
      // therefore also proves the envelope survives structured clone in the
      // fake — the property `test/binary-roundtrip.test.ts` isolates.
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
    }).pipe(Effect.provide(freshLayer())),
  )
})
