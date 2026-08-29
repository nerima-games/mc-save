/**
 * An IndexedDB, in one file, with a fault injector.
 *
 * NOT A TEST — a helper the adapter tests build on. It exists because
 * `vitest.config.ts` runs `environment: 'node'`, and that is a decision rather
 * than a default (`docs/testing.md` §2). The alternative was `fake-indexeddb`
 * from npm, which was rejected on the rule that governs this whole repository:
 * this package has zero runtime dependencies beyond `effect` and every
 * addition is a boundary decision, and — more to the point — a third-party
 * fake is written against `lib.dom.d.ts`, so consuming it would drag `"DOM"`
 * back in through `types` and delete the property
 * `src/domain/indexeddb-surface.ts` exists to protect.
 *
 * The reason this fake is TRUSTWORTHY is `test/fixtures/indexeddb-surface.ts`:
 * it implements `IdbFactory` and friends with NO CAST, and a real `IDBFactory`
 * satisfies those same types with no cast, proved by compiling that fixture
 * against the real `lib.dom.d.ts`. A fake that needed
 * `as unknown as IDBFactory` would prove nothing about a browser — it would
 * prove things about the cast.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES REPRODUCE
 * ---------------------------------------------------------------------------
 *
 * `test/binary-roundtrip.test.ts` states the same kind of boundary for
 * `structuredClone`, and this file is held to it.
 *
 *  - ASYNCHRONY. Every request completes on a microtask, never synchronously.
 *    A fake that called `onsuccess` inline would let the adapter's request chain
 *    be written in any order at all and still pass.
 *  - TRANSACTION AUTO-COMMIT. A transaction commits once the microtask queue
 *    drains with no request outstanding on it, and a request issued afterwards
 *    throws `TransactionInactiveError`. This is the rule that makes the
 *    adapter's "one `Effect.async`, requests chained inside `onsuccess`"
 *    structure NECESSARY rather than stylistic — write `put` as three `yield*`ed
 *    Effects instead and this fake fails it, which is the whole reason the rule
 *    is modelled.
 *  - `oncomplete` AFTER the last `onsuccess`, so "the value reached the
 *    transaction" and "the write is durable" are distinguishable events.
 *  - ROLLBACK. An aborted transaction leaves the store as it was.
 *  - STRUCTURED CLONE, on the way in and on the way out, so a value that no
 *    medium could store fails here for the same reason it fails in a browser.
 *  - KEY ORDER. `getAllKeys` on the store returns ascending key order and on an
 *    index returns primary keys in index order — the difference the adapter's
 *    `by-insertion` index exists to exploit.
 *  - `DOMException`-shaped failures, including a `null` `error` on a
 *    browser-initiated abort.
 *  - `onupgradeneeded` and `onblocked` against a persistent set of databases, so
 *    a second open of the same name sees what the first one wrote.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT REPRODUCE, and what therefore stays a browser question
 * ---------------------------------------------------------------------------
 *
 *  - REAL DURABILITY. Nothing survives the process. "The bytes are still there
 *    after a reload" is mc-compose's row #10, and it is a browser test on
 *    purpose.
 *  - REAL QUOTA. Storage pressure is injected by `failNextWrite`, not reached.
 *    The MAPPING of a quota failure is tested here; the THRESHOLD is not
 *    observable outside a browser.
 *  - KEY RANGES, cursors other than `openCursor(null, 'prev')`, compound and
 *    multi-entry indexes, `versionchange` transactions that touch data, and
 *    concurrency between real connections. None are in
 *    `domain/indexeddb-surface.ts`, and a fake that implemented more than the
 *    surface would be standing in for API the adapter cannot call.
 *  - THE REAL STRUCTURED CLONE ALGORITHM'S EDGE CASES. This uses the platform's
 *    own `structuredClone`, so it is the real algorithm — but a browser's
 *    IndexedDB additionally refuses some values the algorithm accepts, and that
 *    refusal is not modelled.
 */
import type {
  IdbDatabase,
  IdbDomException,
  IdbFactory,
  IdbIndex,
  IdbObjectStore,
  IdbOpenRequest,
  IdbRequest,
  IdbStringList,
  IdbTransaction,
} from '../src/domain/indexeddb-surface.js'

/** A `DOMException` as far as the surface is concerned. */
export const domException = (name: string, message: string): IdbDomException => ({ name, message })

/** The name a browser uses when storage is full; the mapping keys off it. */
export const QUOTA_EXCEEDED_ERROR = 'QuotaExceededError'

type StoredRecord = {
  readonly key: string
  readonly value: unknown
}

type StoreState = {
  readonly name: string
  readonly keyPath: string | undefined
  readonly indexes: Map<string, string>
  /** Keyed by primary key. A `Map` so rollback is a whole-map swap. */
  records: Map<string, StoredRecord>
}

/**
 * `database` is set once the connection's own `IDBDatabase`-shaped object
 * exists, so a LATER, higher-version open can fire `versionchange` on it —
 * the real DOM mechanism that gives the adapter's `database.onversionchange`
 * handler something to respond to, ahead of and instead of blocking forever.
 * `undefined` for a connection synthesised directly by `holdOpenAt`, which
 * models an uncooperative tab with no handler to call.
 */
type Connection = {
  closed: boolean
  database: (IdbDatabase & { onversionchange: ((event: never) => void) | null }) | undefined
}

type DatabaseState = {
  readonly name: string
  version: number
  readonly stores: Map<string, StoreState>
  /** Open connections that have not been closed, for the `blocked` path. */
  readonly connections: Set<Connection>
  /** Retries for an `open()` that reported `blocked`, run again from `close()`. */
  pendingRetry: Array<() => void>
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Every callback goes through here, and nothing is ever called synchronously.
 *
 * `queueMicrotask` and not `setTimeout`: a real IndexedDB request settles
 * without yielding to the macrotask queue, and an Effect-aware test helper
 * would otherwise need fake timers to see any of it. `docs/testing.md` records
 * the related trap — `Effect.fork` plus `Deferred.await` inside an Effect-aware
 * test deadlocks on DOM event
 * flows — and staying on the microtask queue is what keeps these tests clear of
 * it: the adapter's `Effect.async` resumes from a microtask, which the Effect
 * runtime handles without a fibre of its own.
 */
const later = (run: () => void): void => {
  queueMicrotask(run)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type MutableRequest = {
  result: unknown
  error: IdbDomException | null
  onsuccess: ((event: never) => void) | null
  onerror: ((event: never) => void) | null
}

const makeRequest = (): MutableRequest => ({
  result: undefined,
  error: null,
  onsuccess: null,
  onerror: null,
})

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export type FakeIndexedDb = IdbFactory & {
  /**
   * Fail the next write request with this `DOMException` name.
   *
   * Quota cannot be REACHED in a test, so it is INJECTED. The distinction
   * matters and is stated in the header: what is tested here is the mapping
   * from a `DOMException` name to a `StorageError`, not the threshold.
   */
  readonly failNextWrite: (name: string, message?: string) => void
  /**
   * Fail the next write request with a cause that is NOT DOMException-shaped
   * — unlike `failNextWrite`, no `name` is required to be a string. Models a
   * medium response so malformed that even the failure cannot be trusted, the
   * one case `readString`'s own defensive re-check (`domain/indexeddb-storage.ts`)
   * exists for.
   */
  readonly corruptNextWriteWithMalformedCause: (cause: unknown) => void
  /**
   * Abort the transaction the way a browser does — rolled back, `error` null —
   * immediately AFTER its next write lands.
   *
   * After the write and not before it, deliberately. An abort that fires on the
   * first request of a `put` chain never reaches the write at all, so the store
   * is unchanged whether rollback works or not, and a test asserting "the store
   * was left untouched" goes green against an adapter that has no rollback. The
   * injector has to produce a half-done transaction for that assertion to mean
   * anything.
   */
  readonly abortAfterNextWrite: () => void
  /**
   * Make the NEXT call to `transaction.abort()` throw this `DOMException`
   * instead of performing the abort — see the doc comment on `abort` itself
   * for why this is injected rather than reached.
   */
  readonly corruptNextAbort: (failure: IdbDomException) => void
  /** Hold `name` open at `version`, so the next open of a higher version blocks. */
  readonly holdOpenAt: (name: string, version: number) => void
  /** Every database name that exists, for the row #9 port. */
  readonly databaseNames: () => ReadonlyArray<string>
  /** The store names of `name`, or undefined if there is no such database. */
  readonly storeNamesOf: (name: string) => ReadonlyArray<string> | undefined
  /** The index names of one store, so a test can assert the layout it created. */
  readonly indexNamesOf: (name: string, store: string) => ReadonlyArray<string> | undefined
  /** Raw records, so a test can see the shape the adapter chose to write. */
  readonly recordsOf: (name: string, store: string) => ReadonlyArray<unknown> | undefined
  /** Seed a database as an older build would have left it. */
  readonly seed: (name: string, version: number, store: string, records: ReadonlyArray<unknown>) => void
  /** Seed a database whose store predates the insertion index. */
  readonly seedWithoutIndexes: (
    name: string,
    version: number,
    store: string,
    records: ReadonlyArray<unknown>,
  ) => void
  /**
   * Seed a store the way `seed` does, but index each record under an EXPLICIT
   * key rather than a `key` field the record itself must carry.
   *
   * `seed` (and `put`'s `primaryKeyOf`) both require the stored value's own
   * `key` field to be a string, because that is the only shape this adapter
   * ever writes — so `readEnvelope`'s own defensive check for a record
   * present at a real IndexedDB key but with no string `key` field of its own
   * (`domain/indexeddb-storage.ts`) can never be reached through either. Real
   * IndexedDB does not share that restriction: a `keyPath` store only
   * requires SOME value at the key path, of any valid IndexedDB key type, so
   * a foreign writer could leave a record whose own `key` field
   * disagrees with the key IndexedDB actually stored it under. This is that.
   */
  readonly seedAt: (
    name: string,
    version: number,
    store: string,
    entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
  ) => void
  /**
   * Make the next `by-insertion` index `getAllKeys()` answer THIS instead of
   * the real key list.
   *
   * The only way to exercise `readKeys`'s two throws in
   * `domain/indexeddb-storage.ts`: under this fake's own invariants
   * (`primaryKeyOf` on `put`, and the string-key guard in `seed`), the real
   * path can never produce anything but a well-formed array of string keys, so
   * there is no legitimate sequence of `put`/`seed` calls that reaches either
   * throw. This overrides the medium's answer for exactly one call, the same
   * way `failNextWrite` and `abortAfterNextWrite` inject a medium fault rather
   * than a domain one.
   */
  readonly corruptNextIndexKeys: (value: unknown) => void
}

export const makeFakeIndexedDb = (): FakeIndexedDb => {
  const databases = new Map<string, DatabaseState>()
  let pendingWriteFailure: IdbDomException | undefined
  /**
   * Like `pendingWriteFailure`, but not run through `domException`'s
   * string-typed `name` parameter — so a value that is NOT DOMException-shaped
   * can be injected verbatim. `readString` (`domain/indexeddb-storage.ts`)
   * defensively re-checks that a cause's `name` is actually a string before
   * trusting it for the quota comparison; every cause this fake otherwise
   * produces already satisfies that, by construction, so there is no other
   * way to exercise the defensive check being false.
   */
  let pendingMalformedWriteFailure: { readonly value: unknown } | undefined
  let pendingAbort = false
  let pendingIndexKeysOverride: { readonly value: unknown } | undefined
  let pendingAbortFailure: IdbDomException | undefined

  const stringList = (names: ReadonlyArray<string>): IdbStringList => ({
    length: names.length,
    contains: (name) => names.includes(name),
    item: (index) => names[index] ?? null,
  })

  const makeUpgradeTransaction = (state: DatabaseState): IdbTransaction => ({
    objectStore: (name) => {
      const store = state.stores.get(name)
      if (store === undefined) {
        throw domException('NotFoundError', `no object store named "${name}"`)
      }
      return {
        indexNames: stringList([...store.indexes.keys()]),
        get: () => {
          throw domException('InvalidStateError', 'upgrade object stores cannot read records in this fake')
        },
        put: () => {
          throw domException('InvalidStateError', 'upgrade object stores cannot write records in this fake')
        },
        delete: () => {
          throw domException('InvalidStateError', 'upgrade object stores cannot delete records in this fake')
        },
        index: () => {
          throw domException('NotFoundError', 'upgrade object stores cannot open indexes in this fake')
        },
        createIndex: (indexName, keyPath) => {
          store.indexes.set(indexName, keyPath)
          return undefined
        },
      }
    },
    abort: () => {
      throw domException('InvalidStateError', 'the upgrade transaction cannot be aborted by this fake')
    },
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
  })

  const ensureDatabase = (name: string): DatabaseState => {
    const existing = databases.get(name)
    if (existing !== undefined) {
      return existing
    }
    const created: DatabaseState = { name, version: 0, stores: new Map(), connections: new Set(), pendingRetry: [] }
    databases.set(name, created)
    return created
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  const makeTransaction = (
    state: DatabaseState,
    connection: { closed: boolean },
    storeName: string,
    mode: 'readonly' | 'readwrite',
  ): IdbTransaction => {
    const store = state.stores.get(storeName)
    if (store === undefined) {
      throw domException('NotFoundError', `no object store named "${storeName}"`)
    }
    if (connection.closed) {
      throw domException('InvalidStateError', 'the database connection is closing')
    }

    // The snapshot rollback restores. Taken up front so an abort is a swap
    // rather than an undo log.
    const before = new Map(store.records)

    let outstanding = 0
    let finished = false
    let scheduledCommit = false

    // `error` is `readonly` on the surface because the ADAPTER only reads it.
    // The fake has to write it, so the local type says so; the value still
    // satisfies `IdbTransaction`, since readonly does not affect assignability.
    const transaction: Omit<IdbTransaction, 'error'> & { error: IdbDomException | null } = {
      objectStore: (name) => {
        if (finished) {
          throw domException('TransactionInactiveError', 'the transaction has finished')
        }
        if (name !== storeName) {
          throw domException('NotFoundError', `"${name}" is not in this transaction's scope`)
        }
        return objectStore
      },
      abort: () => {
        // Real IndexedDB throws `InvalidStateError` when `abort()` is called
        // on a transaction whose state is already committing or finished —
        // the case `domain/indexeddb-storage.ts`'s `guard` and `onResult`
        // handle by falling back to reporting the ORIGINAL failure rather
        // than losing it to a second, unrelated error. Nothing this adapter
        // does can make that race happen through legitimate use (it issues
        // one request at a time and aborts at most once per transaction), so
        // this injects the medium-level failure directly, the same way
        // `failNextWrite` injects a write failure the request layer alone
        // cannot produce.
        if (pendingAbortFailure !== undefined) {
          const failure = pendingAbortFailure
          pendingAbortFailure = undefined
          // `IdbDomException` is a plain `{ name, message }` shape (see
          // `indexeddb-surface.ts`), not an `Error`; a real `abort()` throws
          // an actual `DOMException` instance, so wrap it the same way here.
          throw new DOMException(failure.message, failure.name)
        }
        abortWith(null)
      },
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
    }

    const settleAbort = (failure: IdbDomException | null): void => {
      store.records = before
      finished = true
      // `error` is nullable on a browser-initiated abort and the adapter must
      // cope with that, so the fake really does hand back `null` here.
      transaction.error = failure
      later(() => {
        transaction.onabort?.(undefined as never)
      })
    }

    const abortWith = (failure: IdbDomException | null): void => {
      if (finished) {
        return
      }
      settleAbort(failure)
    }

    const failWith = (failure: IdbDomException): void => {
      if (finished) {
        return
      }
      transaction.error = failure
      later(() => {
        transaction.onerror?.(undefined as never)
        settleAbort(failure)
      })
    }

    /**
     * Commit when the queue drains with nothing outstanding.
     *
     * Re-checked inside the microtask rather than decided when it was scheduled,
     * because a handler that ran in between may have issued another request —
     * which is exactly the case the adapter depends on and the case a
     * commit-on-schedule fake would get wrong.
     */
    const scheduleCommit = (): void => {
      if (scheduledCommit || finished) {
        return
      }
      scheduledCommit = true
      later(() => {
        scheduledCommit = false
        if (finished || outstanding > 0) {
          return
        }
        finished = true
        transaction.oncomplete?.(undefined as never)
      })
    }

    const submit = (produce: () => unknown, isWrite: boolean): IdbRequest => {
      if (finished) {
        throw domException('TransactionInactiveError', 'the transaction has finished')
      }
      if (mode === 'readonly' && isWrite) {
        throw domException('ReadOnlyError', 'this transaction is read-only')
      }

      const request = makeRequest()
      outstanding += 1

      later(() => {
        outstanding -= 1
        if (finished) {
          return
        }

        if (isWrite && pendingMalformedWriteFailure !== undefined) {
          const { value } = pendingMalformedWriteFailure
          pendingMalformedWriteFailure = undefined
          // Cast deliberately: this is the one path that bypasses the
          // DOMException shape the rest of the fake enforces, on purpose.
          request.error = value as IdbDomException
          request.onerror?.(undefined as never)
          failWith(value as IdbDomException)
          return
        }

        const injected = isWrite ? pendingWriteFailure : undefined
        if (injected !== undefined) {
          pendingWriteFailure = undefined
          request.error = injected
          request.onerror?.(undefined as never)
          failWith(injected)
          return
        }

        try {
          request.result = produce()
        } catch (cause) {
          const failure =
            typeof cause === 'object' && cause !== null && 'name' in cause
              ? (cause as IdbDomException)
              : domException('UnknownError', String(cause))
          request.error = failure
          request.onerror?.(undefined as never)
          failWith(failure)
          return
        }

        if (pendingAbort && isWrite) {
          pendingAbort = false
          // The browser's own abort: no error, the work rolled back, and the
          // caller finds out only through `onabort`.
          abortWith(null)
          return
        }

        request.onsuccess?.(undefined as never)
        scheduleCommit()
      })

      return request
    }

    const clone = (value: unknown): unknown => structuredClone(value)

    const primaryKeyOf = (value: unknown): string => {
      const path = store.keyPath
      if (path === undefined) {
        throw domException('DataError', 'this store has no key path')
      }
      const holder: unknown =
        typeof value === 'object' && value !== null
          ? (value as Readonly<Record<string, unknown>>)[path]
          : undefined
      if (typeof holder !== 'string') {
        throw domException('DataError', `the record has no string at key path "${path}"`)
      }
      return holder
    }

    const indexOf = (indexName: string): IdbIndex => {
      const keyPath = store.indexes.get(indexName)
      if (keyPath === undefined) {
        throw domException('NotFoundError', `no index named "${indexName}"`)
      }

      /** Records carrying a value at the index key path, ordered by it. */
      const ordered = (): ReadonlyArray<StoredRecord> =>
        [...store.records.values()]
          .filter((record) => indexKeyOf(record.value, keyPath) !== undefined)
          .sort((left, right) => {
            const a = indexKeyOf(left.value, keyPath) ?? 0
            const b = indexKeyOf(right.value, keyPath) ?? 0
            return a - b
          })

      return {
        getAllKeys: () =>
          submit(() => {
            if (pendingIndexKeysOverride !== undefined) {
              const { value } = pendingIndexKeysOverride
              pendingIndexKeysOverride = undefined
              return value
            }
            return ordered().map((record) => record.key)
          }, false),
        openCursor: (_query, direction) =>
          submit(() => {
            const rows = ordered()
            const chosen = direction === 'prev' ? rows[rows.length - 1] : rows[0]
            // A cursor past the end is `null`, which is how the adapter learns
            // the store is empty and starts its sequence at zero.
            return chosen === undefined ? null : { value: clone(chosen.value) }
          }, false),
      }
    }

    const objectStore: IdbObjectStore = {
      get indexNames(): IdbStringList {
        return stringList([...store.indexes.keys()])
      },
      get: (key) => submit(() => clone(store.records.get(key)?.value), false),
      put: (value) =>
        submit(() => {
          // Cloned on the way IN as well as out: a value the algorithm refuses
          // fails here for the same reason it fails in a browser, and a later
          // mutation of the caller's object cannot reach the store.
          const stored = clone(value)
          const key = primaryKeyOf(stored)
          store.records.set(key, { key, value: stored })
          return key
        }, true),
      delete: (key) =>
        submit(() => {
          store.records.delete(key)
          return undefined
        }, true),
      index: indexOf,
      createIndex: (name, keyPath) => {
        store.indexes.set(name, keyPath)
        return undefined
      },
    }

    return transaction
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  const open = (name: string, version?: number): IdbOpenRequest => {
    /**
     * `result` is a GETTER that throws until the database exists.
     *
     * That is what a browser does — reading `IDBRequest.result` before the
     * request has settled throws `InvalidStateError` — and modelling it is what
     * keeps the adapter honest about only ever touching `result` inside a
     * handler. A plain `undefined` slot would let a careless read compile, run,
     * and hand `undefined` onwards as if it were a database.
     */
    let opened: IdbDatabase | undefined

    const request: Omit<MutableRequest, 'result'> & {
      readonly result: IdbDatabase
      transaction: IdbTransaction | null
      onupgradeneeded: ((event: never) => void) | null
      onblocked: ((event: never) => void) | null
    } = {
      get result(): IdbDatabase {
        if (opened === undefined) {
          throw domException('InvalidStateError', 'the open request has not completed')
        }
        return opened
      },
      error: null,
      onsuccess: null,
      onerror: null,
      transaction: null,
      onupgradeneeded: null,
      onblocked: null,
    }

    /**
     * One attempt to complete this open. Re-invoked, via `state.pendingRetry`,
     * when a connection that was blocking this exact request later closes —
     * mirroring the real DOM: `blocked` does not kill the request, it stays
     * pending and can still fire `upgradeneeded`/`success` once whatever was
     * in the way leaves. Without a retry path, `settle`'s own "already
     * settled" guard (`domain/indexeddb-storage.ts`) — there specifically
     * because a real request CAN report twice — would have nothing to guard
     * against here.
     */
    const attempt = (): void => {
      const state = ensureDatabase(name)
      const wanted = version ?? Math.max(state.version, 1)

      if (wanted < state.version) {
        request.error = domException(
          'VersionError',
          `requested version ${String(wanted)} is less than the existing ${String(state.version)}`,
        )
        request.onerror?.(undefined as never)
        return
      }

      if (wanted > state.version) {
        // The real DOM fires `versionchange` on every OTHER live connection
        // BEFORE deciding whether the open is blocked, giving each one a
        // chance to `close()` itself in response — which is the entire reason
        // `domain/indexeddb-storage.ts` registers `database.onversionchange`.
        // A cooperative connection (this adapter's) closes synchronously here
        // and so is gone from `state.connections` by the time `blocking` is
        // computed below; an uncooperative one (no handler, e.g. one
        // synthesised by `holdOpenAt`) is not, and genuinely blocks.
        for (const other of state.connections) {
          other.database?.onversionchange?.(undefined as never)
        }
      }

      const blocking = [...state.connections].some((connection) => !connection.closed)
      if (wanted > state.version && blocking) {
        // Exactly the DOM's behaviour: the open does NOT fail and does NOT
        // proceed on its own. It reports `blocked` and stays pending — retried
        // from `close()` below once every connection in the way has left.
        //
        // Registered BEFORE `onblocked` fires, deliberately: a handler that
        // closes the blocking connection synchronously (as this adapter's own
        // `onversionchange` does) must find the retry already queued, or the
        // wake-up it just caused has nothing to wake.
        state.pendingRetry.push(() => {
          later(attempt)
        })
        request.onblocked?.(undefined as never)
        return
      }

      const connection: Connection = { closed: false, database: undefined }
      state.connections.add(connection)

      const database: IdbDatabase & { onversionchange: ((event: never) => void) | null } = {
        name: state.name,
        get version(): number {
          return state.version
        },
        get objectStoreNames(): IdbStringList {
          return stringList([...state.stores.keys()])
        },
        createObjectStore: (storeName, options) => {
          if (state.stores.has(storeName)) {
            throw domException('ConstraintError', `"${storeName}" already exists`)
          }
          const created: StoreState = {
            name: storeName,
            keyPath: options?.keyPath,
            indexes: new Map(),
            records: new Map(),
          }
          state.stores.set(storeName, created)
          // Returned so the upgrade handler can add indexes to it. The
          // transaction machinery is not involved: an upgrade in this fake is
          // synchronous, which is the one place it is SIMPLER than a browser.
          return {
            get indexNames(): IdbStringList {
              return stringList([...created.indexes.keys()])
            },
            get: () => makeRequest(),
            put: () => makeRequest(),
            delete: () => makeRequest(),
            index: () => {
              throw domException('NotFoundError', 'no index')
            },
            createIndex: (indexName, keyPath) => {
              created.indexes.set(indexName, keyPath)
              return undefined
            },
          }
        },
        transaction: (storeNames, mode) =>
          makeTransaction(state, connection, storeNames, mode ?? 'readonly'),
        close: () => {
          connection.closed = true
          state.connections.delete(connection)
          // Wake up anyone whose `open()` reported `blocked` on account of
          // this connection. Snapshot-and-clear rather than iterate-in-place:
          // a retry that blocks again pushes a NEW entry onto `pendingRetry`,
          // and running that in the same pass would be an infinite loop.
          if (state.pendingRetry.length > 0) {
            const retries = state.pendingRetry
            state.pendingRetry = []
            for (const retry of retries) retry()
          }
        },
        onversionchange: null,
      }

      connection.database = database
      opened = database

      if (wanted > state.version) {
        state.version = wanted
        request.transaction = makeUpgradeTransaction(state)
        try {
          request.onupgradeneeded?.(undefined as never)
        } finally {
          request.transaction = null
        }
      }

      request.onsuccess?.(undefined as never)
    }

    later(attempt)

    return request
  }

  const indexKeyOf = (value: unknown, keyPath: string): number | undefined => {
    const holder: unknown =
      typeof value === 'object' && value !== null
        ? (value as Readonly<Record<string, unknown>>)[keyPath]
        : undefined
    return typeof holder === 'number' ? holder : undefined
  }

  const seedStore = (
    name: string,
    version: number,
    store: string,
    records: ReadonlyArray<unknown>,
    indexes: ReadonlyArray<readonly [string, string]>,
  ): void => {
    const state = ensureDatabase(name)
    state.version = version
    const created: StoreState = {
      name: store,
      keyPath: 'key',
      indexes: new Map(indexes),
      records: new Map(),
    }
    for (const record of records) {
      const holder =
        typeof record === 'object' && record !== null
          ? (record as Readonly<Record<string, unknown>>)['key']
          : undefined
      if (typeof holder === 'string') {
        created.records.set(holder, { key: holder, value: record })
      }
    }
    state.stores.set(store, created)
  }

  return {
    open,
    databases: () =>
      Promise.resolve([...databases.values()].map((state) => ({ name: state.name, version: state.version }))),
    failNextWrite: (name, message = name) => {
      pendingWriteFailure = domException(name, message)
    },
    corruptNextWriteWithMalformedCause: (cause) => {
      pendingMalformedWriteFailure = { value: cause }
    },
    abortAfterNextWrite: () => {
      pendingAbort = true
    },
    corruptNextAbort: (failure) => {
      pendingAbortFailure = failure
    },
    holdOpenAt: (name, version) => {
      const state = ensureDatabase(name)
      state.version = version
      // No `database`, deliberately: this connection has no handler to call,
      // the uncooperative tab this method exists to model.
      state.connections.add({ closed: false, database: undefined })
    },
    databaseNames: () => [...databases.keys()],
    storeNamesOf: (name) => {
      const state = databases.get(name)
      return state === undefined ? undefined : [...state.stores.keys()]
    },
    indexNamesOf: (name, store) => {
      const found = databases.get(name)?.stores.get(store)
      return found === undefined ? undefined : [...found.indexes.keys()]
    },
    recordsOf: (name, store) => {
      const found = databases.get(name)?.stores.get(store)
      return found === undefined ? undefined : [...found.records.values()].map((record) => record.value)
    },
    seed: (name, version, store, records) =>
      seedStore(name, version, store, records, [['by-insertion', 'seq']]),
    seedWithoutIndexes: (name, version, store, records) => seedStore(name, version, store, records, []),
    seedAt: (name, version, store, entries) => {
      const state = ensureDatabase(name)
      state.version = version
      const created: StoreState = {
        name: store,
        keyPath: 'key',
        indexes: new Map([['by-insertion', 'seq']]),
        records: new Map(),
      }
      for (const { key, value } of entries) {
        created.records.set(key, { key, value })
      }
      state.stores.set(store, created)
    },
    corruptNextIndexKeys: (value) => {
      pendingIndexKeysOverride = { value }
    },
  }
}
