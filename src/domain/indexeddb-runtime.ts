import { Effect, Result } from 'effect'
import {
  INSERTION_INDEX_NAME,
  isQuotaExceededCause,
  QUOTA_EXCEEDED_MARKER,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
  type IndexedDbStorageOptions,
} from './indexeddb-layout.js'
import type { IdbDatabase, IdbObjectStore, IdbRequest } from './indexeddb-surface.js'
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
  Effect.callback<IdbDatabase, StorageError>((resume) => {
    const operation = 'indexeddb.open'
    let settled = false
    const settle = (outcome: Effect.Effect<IdbDatabase, StorageError>): void => {
      if (settled) return
      settled = true
      resume(outcome)
    }
    const opened = Result.try({
      try: () => options.factory.open(options.databaseName, STORE_LAYOUT_VERSION),
      catch: (cause) => cause,
    })
    if (Result.isFailure(opened)) {
      settle(Effect.fail(failureFor(operation, options.databaseName, opened.failure)))
      return
    }
    const request = opened.success
    const handlers = Result.try({
      try: () => {
        request.onupgradeneeded = () => {
          const upgraded = Result.try({
            try: () => {
              const database = request.result
              const store = database.objectStoreNames.contains(SAVE_STORE_NAME)
                ? request.transaction?.objectStore(SAVE_STORE_NAME)
                : database.createObjectStore(SAVE_STORE_NAME, { keyPath: 'key' })
              if (store === undefined) return 'IndexedDB upgrade transaction is unavailable'
              if (!store.indexNames.contains(INSERTION_INDEX_NAME)) {
                store.createIndex(INSERTION_INDEX_NAME, 'seq')
              }
              return undefined
            },
            catch: (cause) => cause,
          })
          if (Result.isFailure(upgraded) || upgraded.success !== undefined) {
            const cause = Result.isFailure(upgraded) ? upgraded.failure : upgraded.success
            Result.try({
              try: () => request.transaction?.abort(),
              catch: () => undefined,
            })
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
          const error = Result.try({
            try: () => request.error,
            catch: (cause) => cause,
          })
          settle(Effect.fail(failureFor(operation, options.databaseName, Result.isFailure(error) ? error.failure : error.success)))
        }
        request.onsuccess = () => {
          const openedDatabase = Result.try({
            try: () => request.result,
            catch: (cause) => cause,
          })
          if (Result.isFailure(openedDatabase)) {
            settle(Effect.fail(failureFor(operation, options.databaseName, openedDatabase.failure)))
            return
          }
          const database = openedDatabase.success
          if (settled) {
            Result.try({ try: () => database.close(), catch: () => undefined })
            return
          }
          const versionChange = Result.try({
            try: () => {
              database.onversionchange = () => {
                Result.try({ try: () => database.close(), catch: () => undefined })
              }
            },
            catch: (cause) => cause,
          })
          if (Result.isFailure(versionChange)) {
            Result.try({ try: () => database.close(), catch: () => undefined })
            settle(Effect.fail(failureFor(operation, options.databaseName, versionChange.failure)))
            return
          }
          settle(Effect.succeed(database))
        }
      },
      catch: (cause) => cause,
    })
    if (Result.isFailure(handlers)) {
      settle(Effect.fail(failureFor(operation, options.databaseName, handlers.failure)))
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
    fail: (cause: unknown) => void,
  ) => void,
): Effect.Effect<A, StorageError> =>
  Effect.callback<A, StorageError>((resume) => {
    let settled = false
    let delivered: { readonly value: A } | undefined
    let pendingFailure: { readonly cause: unknown } | undefined
    const settle = (outcome: Effect.Effect<A, StorageError>): void => {
      if (settled) return
      settled = true
      resume(outcome)
    }
    const settleFailure = (cause: unknown): void => {
      pendingFailure ??= { cause }
      settle(Effect.fail(failureFor(operation, key, pendingFailure.cause)))
    }
    let abort: (cause: unknown) => void = settleFailure
    const fail = (cause: unknown): void => {
      if (settled) return
      pendingFailure ??= { cause }
      abort(pendingFailure.cause)
    }
    const created = Result.try({
      try: () => database.transaction(SAVE_STORE_NAME, mode),
      catch: (cause) => cause,
    })
    if (Result.isFailure(created)) {
      settleFailure(created.failure)
      return
    }
    const transaction = created.success
    abort = (cause: unknown): void => {
      if (settled) return
      pendingFailure ??= { cause }
      const aborted = Result.try({
        try: () => transaction.abort(),
        catch: (abortCause) => abortCause,
      })
      if (Result.isFailure(aborted)) settleFailure(pendingFailure.cause)
    }
    const handlers = Result.try({
      try: () => {
        transaction.onerror = () => {
          const error = Result.try({
            try: () => transaction.error,
            catch: (cause) => cause,
          })
          pendingFailure ??= { cause: Result.isFailure(error) ? error.failure : error.success }
        }
        transaction.onabort = () => {
          const error = Result.try({
            try: () => transaction.error,
            catch: (cause) => cause,
          })
          settleFailure(pendingFailure === undefined ? (Result.isFailure(error) ? error.failure : error.success) : pendingFailure.cause)
        }
        transaction.oncomplete = () => {
          if (delivered === undefined) {
            settle(
              Effect.fail(
                storageError(
                  `${operation}:incomplete`,
                  key,
                  'the transaction committed without producing a result',
                ),
              ),
            )
          } else {
            settle(Effect.succeed(delivered.value))
          }
        }
      },
      catch: (cause) => cause,
    })
    if (Result.isFailure(handlers)) {
      abort(handlers.failure)
      return
    }
    const guard = (body: () => void): void => {
      const outcome = Result.try({ try: body, catch: (cause) => cause })
      if (Result.isFailure(outcome)) abort(outcome.failure)
    }
    const onResult = (request: IdbRequest, next: (result: unknown) => void): void => {
      guard(() => {
        request.onsuccess = () => {
          guard(() => next(request.result))
        }
        request.onerror = () => {
          const error = Result.try({
            try: () => request.error,
            catch: (cause) => cause,
          })
          abort(Result.isFailure(error) ? error.failure : error.success)
        }
      })
    }
    guard(() => {
      start(
        transaction.objectStore(SAVE_STORE_NAME),
        (value) => {
          delivered = { value }
        },
        onResult,
        fail,
      )
    })
  })
