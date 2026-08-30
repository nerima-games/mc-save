import { Effect } from 'effect'
import {
  INSERTION_INDEX_NAME,
  isQuotaExceededCause,
  QUOTA_EXCEEDED_MARKER,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
  type IndexedDbStorageOptions,
} from './indexeddb-layout.js'
import type { IdbDatabase, IdbObjectStore, IdbOpenRequest, IdbRequest } from './indexeddb-surface.js'
import { StorageError } from './errors.js'

const storageError = (operation: string, key: string | undefined, cause: unknown): StorageError =>
  new StorageError({
    operation,
    ...(key === undefined ? {} : { key }),
    ...(cause === undefined ? {} : { cause }),
  })

const failureFor = (operation: string, key: string | undefined, cause: unknown): StorageError =>
  cause instanceof StorageError
    ? cause
    : storageError(
        isQuotaExceededCause(cause) ? `${operation}${QUOTA_EXCEEDED_MARKER}` : operation,
        key,
        cause,
      )

export const openDatabase = (options: IndexedDbStorageOptions): Effect.Effect<IdbDatabase, StorageError> =>
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

    let request: IdbOpenRequest
    try {
      request = options.factory.open(options.databaseName, STORE_LAYOUT_VERSION)
    } catch (cause) {
      settle(Effect.fail(failureFor(operation, options.databaseName, cause)))
      return
    }

    request.onupgradeneeded = () => {
      try {
        const database = request.result
        const store = database.objectStoreNames.contains(SAVE_STORE_NAME)
          ? request.transaction?.objectStore(SAVE_STORE_NAME)
          : database.createObjectStore(SAVE_STORE_NAME, { keyPath: 'key' })
        if (store === undefined) {
          throw new TypeError('IndexedDB upgrade transaction is unavailable')
        }
        if (!store.indexNames.contains(INSERTION_INDEX_NAME)) {
          store.createIndex(INSERTION_INDEX_NAME, 'seq')
        }
      } catch (cause) {
        try {
          request.transaction?.abort()
        } catch {
          return settle(Effect.fail(failureFor(operation, options.databaseName, cause)))
        }
        settle(Effect.fail(failureFor(operation, options.databaseName, cause)))
      }
    }

    request.onblocked = () => {
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
      if (settled) {
        database.close()
        return
      }
      database.onversionchange = () => {
        database.close()
      }
      settle(Effect.succeed(database))
    }
  })

export const runTransaction = <A>(
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
