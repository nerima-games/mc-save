/**
 * NOT A TEST — a fixture that is COMPILED by one.
 *
 * `test/indexeddb-surface.test.ts` builds a TypeScript program over this file
 * with `lib: ["ES2024", "DOM"]` and asserts it produces zero diagnostics. That
 * is what proves the claim `domain/indexeddb-surface.ts` makes: a real
 * `IDBFactory`, `IDBDatabase`, `IDBTransaction`, `IDBObjectStore`, `IDBIndex`
 * and `IDBRequest` satisfy the adapter's structural types WITHOUT A CAST.
 *
 * The claim is not obvious and it is not stable under a careless edit. Under
 * `strictFunctionTypes` a function-typed PROPERTY is contravariant in its
 * parameter, so `onsuccess: (() => void) | null` — the spelling everybody
 * reaches for first — makes a real `IDBRequest` UNASSIGNABLE. Nothing in the
 * ordinary `pnpm typecheck` would notice, because that project has no DOM to be
 * assignable FROM; the first person to notice would be a browser consumer, and
 * the fix they would reach for is `as unknown as`, which is where the type
 * safety would actually be lost.
 *
 * Excluded from `tsconfig.json` and `tsconfig.test.json` (`test/fixtures/**`),
 * because it names DOM types those projects deliberately cannot see. It is
 * still linted (`pnpm lint` scans all of `test`).
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
} from '../../src/domain/indexeddb-surface.js'

declare const browserIndexedDb: IDBFactory
declare const browserOpenRequest: IDBOpenDBRequest
declare const browserRequest: IDBRequest<unknown>
declare const browserDatabase: IDBDatabase
declare const browserTransaction: IDBTransaction
declare const browserStore: IDBObjectStore
declare const browserIndex: IDBIndex
declare const browserNames: DOMStringList
declare const browserException: DOMException

/** `globalThis.indexedDB`, as a browser host would hand it to the adapter. */
export const factoryIsAnIdbFactory: IdbFactory = browserIndexedDb

/**
 * The two request kinds. `IDBOpenDBRequest` is the one with `onupgradeneeded`
 * and `onblocked`, and its `result` really is an `IDBDatabase`.
 */
export const openRequestIsAnIdbOpenRequest: IdbOpenRequest = browserOpenRequest
export const requestIsAnIdbRequest: IdbRequest = browserRequest

export const databaseIsAnIdbDatabase: IdbDatabase = browserDatabase
export const transactionIsAnIdbTransaction: IdbTransaction = browserTransaction
export const storeIsAnIdbObjectStore: IdbObjectStore = browserStore
export const indexIsAnIdbIndex: IdbIndex = browserIndex

/**
 * `DOMStringList` is NOT declared iterable in `lib.dom.d.ts`, which is why the
 * surface models `contains` and `item` rather than a spread. If this line ever
 * needs `[...browserNames]`, that is the compiler saying the surface changed.
 */
export const namesAreAnIdbStringList: IdbStringList = browserNames

/** `DOMException` really has `name` and `message`; the mapping reads only those. */
export const exceptionIsAnIdbDomException: IdbDomException = browserException

/**
 * THE DIRECTION THAT ACTUALLY BITES.
 *
 * Everything above checks that the real thing is assignable to our type. This
 * checks the other direction that matters in practice: a handler WE write has
 * to be acceptable to the REAL slot, whose declared type is
 * `((this: IDBRequest<any>, ev: Event) => any) | null`.
 *
 * A zero-argument arrow is assignable to that (fewer parameters is always fine
 * in the source position), which is exactly why the surface can demand `never`
 * on the way in and still be driven with `() => {}` on the way out.
 */
export const installsHandlersOnTheRealThing = (): void => {
  browserRequest.onsuccess = () => undefined
  browserRequest.onerror = () => undefined
  browserOpenRequest.onupgradeneeded = () => undefined
  browserOpenRequest.onblocked = () => undefined
  browserDatabase.onversionchange = () => undefined
  browserTransaction.oncomplete = () => undefined
  browserTransaction.onerror = () => undefined
  browserTransaction.onabort = () => undefined
}

/**
 * The whole adapter flow, spelled against the NARROW types but executed on real
 * objects — the shape `makeIndexedDbStorage` drives.
 *
 * If a future edit widens a parameter (say `transaction` gaining
 * `'versionchange'`, or `get` gaining `IDBKeyRange`), this function is where the
 * compiler will say so against the real declarations.
 */
export const drivesTheRealApiThroughTheNarrowTypes = (): void => {
  const factory: IdbFactory = browserIndexedDb
  const request = factory.open('mc-save/fixture', 2)

  request.onupgradeneeded = () => {
    // The upgrade path: the event is UNREADABLE here, on purpose. See the
    // header of `domain/indexeddb-surface.ts`.
    const database = request.result
    const store = database.objectStoreNames.contains('saves')
      ? request.transaction?.objectStore('saves')
      : database.createObjectStore('saves', { keyPath: 'key' })
    if (store === undefined) {
      throw new TypeError('IndexedDB upgrade transaction is unavailable')
    }
    if (!store.indexNames.contains('by-insertion')) {
      store.createIndex('by-insertion', 'seq')
    }
  }

  request.onsuccess = () => {
    const database: IdbDatabase = request.result
    database.onversionchange = () => {
      database.close()
    }

    const transaction = database.transaction('saves', 'readwrite')
    const store = transaction.objectStore('saves')

    store.put({ key: 'a', seq: 0, envelope: { format: 'f', version: 1, payload: null } })
    store.get('a').onsuccess = () => undefined
    store.delete('a')

    const index = store.index('by-insertion')
    index.getAllKeys().onsuccess = () => undefined
    index.openCursor(null, 'prev').onsuccess = () => undefined

    transaction.oncomplete = () => undefined
    transaction.onabort = () => {
      // `error` is nullable on a browser-initiated abort, so the mapping must
      // cope with `null` rather than read through it.
      const failure: IdbDomException | null = transaction.error
      if (failure !== null) {
        void failure.name
      }
    }
    transaction.abort()

    database.close()
  }
}

/**
 * `databases()` is optional in the surface because Firefox does not have it.
 *
 * A real `IDBFactory` in `lib.dom.d.ts` DOES declare it, and this line proves
 * the optional member is satisfied by the required one — the direction that
 * would break if the return type were spelled more tightly than
 * `IDBDatabaseInfo[]`.
 */
export const enumeratesDatabases = async (): Promise<ReadonlyArray<string>> => {
  const factory: IdbFactory = browserIndexedDb
  const listed = (await factory.databases?.()) ?? []
  return listed.flatMap((entry) => (entry.name === undefined ? [] : [entry.name]))
}
