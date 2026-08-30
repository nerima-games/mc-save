/**
 * Transaction, error, retry, and persistence-path behavior for IndexedDB.
 *
 * Database naming and upgrade layout assertions live in focused companion
 * files so this suite can stay centered on adapter operations.
 */
import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Exit, Option, Schema, Scope } from 'effect'
import { defineFormat } from '../src/domain/format.js'
import type { SaveEnvelope } from '../src/domain/envelope.js'
import {
  INSERTION_INDEX_NAME,
  indexedDbStorageLayer,
  isQuotaExceeded,
  makeIndexedDbStorage,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
} from '../src/domain/indexeddb-storage.js'
import type {
  IdbDatabase,
  IdbFactory,
  IdbOpenRequest,
  IdbStringList,
  IdbTransaction,
} from '../src/domain/indexeddb-surface.js'
import { openDatabase, runTransaction } from '../src/domain/indexeddb-runtime.js'
import { loadFrom, saveTo } from '../src/domain/persistence.js'
import { SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { domException, makeFakeIndexedDb, QUOTA_EXCEEDED_ERROR } from './fake-indexeddb.js'
import { storagePortContract } from './storage-port-contract.js'
import { sealedTestEnvelope, unsealedTestEnvelope } from './support/save-envelope.js'

const DATABASE = 'mc-save/test/worlds'
const A = SaveKey('alpha')
const B = SaveKey('beta')
const envelope = (payload: unknown) => sealedTestEnvelope('mc-save/test/idb', 1, payload)
const unsealedEnvelope = (payload: unknown): SaveEnvelope =>
  unsealedTestEnvelope('mc-save/test/idb', 1, payload)

const layerFor = (factory: IdbFactory, databaseName = DATABASE) =>
  indexedDbStorageLayer({ factory, databaseName })

/** A fresh medium per run, which is what isolation means for a real adapter. */
const freshLayer = () => layerFor(makeFakeIndexedDb())

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

      const sequences = (factory.recordsOf(DATABASE, SAVE_STORE_NAME) ?? []).map(
        (record) => (record as { readonly seq: number }).seq,
      )
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
      const transaction: {
        readonly objectStore: () => object
        readonly abort: () => void
        readonly error: undefined
        oncomplete: ((event: never) => void) | null
        onerror: ((event: never) => void) | null
        onabort: ((event: never) => void) | null
      } = {
        objectStore: () => ({}),
        abort: () => undefined,
        error: undefined,
        oncomplete: null,
        onerror: null,
        onabort: null,
      }
      const database = { transaction: () => transaction } as unknown as IdbDatabase

      const error = yield* Effect.flip(
        runTransaction(database, 'readonly', 'indexeddb.test', undefined, () => {
          queueMicrotask(() => transaction.onabort?.(undefined as never))
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
              let failure: { readonly name: string; readonly message: string } | null = null
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
                  request.onupgradeneeded?.(undefined as never)
                  request.onsuccess?.(undefined as never)
                } catch {
                  failure = domException('AbortError', 'the upgrade transaction was unavailable')
                  request.onerror?.(undefined as never)
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
          databaseName: `${DATABASE}/upgrade-failure`,
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
                request.onupgradeneeded?.(undefined as never)
                request.onsuccess?.(undefined as never)
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
      expect((throwingAbort.cause as Error).message).toBe('the upgrade callback failed')
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
      const first = yield* makeIndexedDbStorage({ factory, databaseName: DATABASE }).pipe(Scope.extend(scope))
      yield* first.put(A, envelope({ n: 1 }))

      const outcome = yield* Effect.async<'success' | 'blocked' | 'error'>((resume) => {
        const request = factory.open(DATABASE, STORE_LAYOUT_VERSION + 1)
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

      const first = yield* Effect.async<IdbDatabase>((resume) => {
        const request = factory.open(DATABASE, STORE_LAYOUT_VERSION)
        request.onupgradeneeded = () => undefined
        request.onsuccess = () => {
          resume(Effect.succeed(request.result))
        }
      })

      const reports: Array<'blocked' | 'success'> = []
      const second = yield* Effect.async<'success'>((resume) => {
        const request = factory.open(DATABASE, STORE_LAYOUT_VERSION + 1)
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
      const blocker = yield* Effect.async<IdbDatabase>((resume) => {
        const request = factory.open(DATABASE, 0)
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
      adapterRequest?.onerror?.(undefined as never)

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

  effect('a malformed record makes compare-and-set fail as a conflict', () =>
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
      expect(error.operation).toBe('indexeddb.commitBatch:conflict')
      expect(error.key).toBe('alpha')
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
      // `corruptNextIndexKeys`'s own doc comment. This is `readKeys`'s first
      // throw (`domain/indexeddb-storage.ts`), caught by `runTransaction`'s
      // `guard` and surfaced as a `StorageError` rather than an uncaught
      // exception or a hang.
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
        factory.corruptNextIndexKeys('not-an-array')
        return yield* Effect.flip(storage.keys)
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.keys')
      expect(error.cause).toBeInstanceOf(TypeError)
      expect((error.cause as TypeError).message).toContain(INSERTION_INDEX_NAME)
    }),
  )

  effect('a malformed index answer (a non-string entry) fails keys as a StorageError', () =>
    Effect.gen(function* () {
      // `readKeys`'s second throw: the outer value is an array, but not every
      // entry is a string.
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
        factory.corruptNextIndexKeys(['alpha', 123])
        return yield* Effect.flip(storage.keys)
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.keys')
      expect(error.cause).toBeInstanceOf(TypeError)
      expect((error.cause as TypeError).message).toContain(SAVE_STORE_NAME)
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
      expect(error.cause).toBeInstanceOf(TypeError)
      expect((error.cause as TypeError).message).toContain(INSERTION_INDEX_NAME)
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
