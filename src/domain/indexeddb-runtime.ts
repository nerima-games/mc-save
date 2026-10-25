import { Effect, Result } from 'effect'
import {
  IndexedDbDatabaseName,
  StorageOperation,
  type IndexedDbDatabaseName as IndexedDbDatabaseNameType,
} from './brand-types.js'
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
import { SaveKey, type SaveKey as SaveKeyType } from './save-key.js'

type IndexedDbOperation = StorageOperation | `indexeddb.${string}`
type IndexedDbErrorKey = IndexedDbDatabaseNameType | SaveKeyType

const OPEN_OPERATION = StorageOperation('indexeddb.open')
const TRANSACTION_OPERATION = StorageOperation('indexeddb.transaction')
const operationWithSuffix = (
  operation: StorageOperation,
  suffix: ':blocked' | ':incomplete' | typeof QUOTA_EXCEEDED_MARKER,
): StorageOperation => StorageOperation(`${operation}${suffix}`)

const storageError = (
  operation: StorageOperation,
  key: IndexedDbErrorKey | undefined,
  cause: unknown,
): StorageError =>
  new StorageError({
    operation,
    ...(key === undefined ? {} : { key }),
    ...(cause === undefined ? {} : { cause }),
  })

const failureFor = (
  operation: StorageOperation,
  key: IndexedDbErrorKey | undefined,
  cause: unknown,
): StorageError =>
  cause instanceof StorageError
    ? cause
    : storageError(
        isQuotaExceededCause(cause) ? operationWithSuffix(operation, QUOTA_EXCEEDED_MARKER) : operation,
        key,
        cause,
      )

export const openDatabase = (options: IndexedDbStorageOptions): Effect.Effect<IdbDatabase, StorageError> =>
  Effect.callback<IdbDatabase, StorageError>((resume) => {
    const operation = OPEN_OPERATION
    const observedName = Result.try({
      try: () => options.databaseName,
      catch: (cause) => cause,
    })
    if (Result.isFailure(observedName)) {
      resume(Effect.fail(failureFor(operation, undefined, observedName.failure)))
      return
    }
    const checkedName = IndexedDbDatabaseName.result(observedName.success)
    if (Result.isFailure(checkedName)) {
      resume(Effect.fail(storageError(operation, undefined, checkedName.failure)))
      return
    }
    const databaseName = checkedName.success
    let settled = false
    const settle = (outcome: Effect.Effect<IdbDatabase, StorageError>): void => {
      if (settled) return
      settled = true
      resume(outcome)
    }
    const opened = Result.try({
      try: () => options.factory.open(databaseName, STORE_LAYOUT_VERSION),
      catch: (cause) => cause,
    })
    if (Result.isFailure(opened)) {
      settle(Effect.fail(failureFor(operation, databaseName, opened.failure)))
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
            settle(Effect.fail(failureFor(operation, databaseName, cause)))
          }
        }
        request.onblocked = () => {
          settle(
            Effect.fail(
              storageError(
                operationWithSuffix(operation, ':blocked'),
                databaseName,
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
          settle(Effect.fail(failureFor(operation, databaseName, Result.isFailure(error) ? error.failure : error.success)))
        }
        request.onsuccess = () => {
          const openedDatabase = Result.try({
            try: () => request.result,
            catch: (cause) => cause,
          })
          if (Result.isFailure(openedDatabase)) {
            settle(Effect.fail(failureFor(operation, databaseName, openedDatabase.failure)))
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
            settle(Effect.fail(failureFor(operation, databaseName, versionChange.failure)))
            return
          }
          settle(Effect.succeed(database))
        }
      },
      catch: (cause) => cause,
    })
    if (Result.isFailure(handlers)) {
      settle(Effect.fail(failureFor(operation, databaseName, handlers.failure)))
    }
  })

export const runTransaction = <A>(
  database: IdbDatabase,
  mode: 'readonly' | 'readwrite',
  operation: IndexedDbOperation,
  key: SaveKeyType | undefined,
  start: (
    store: IdbObjectStore,
    deliver: (value: A) => void,
    onResult: (request: IdbRequest, next: (result: unknown) => void) => void,
    fail: (cause: unknown) => void,
  ) => void,
): Effect.Effect<A, StorageError> =>
  Effect.callback<A, StorageError>((resume) => {
    const checkedKey = key === undefined ? Result.succeed(undefined) : SaveKey.result(key)
    if (Result.isFailure(checkedKey)) {
      resume(Effect.fail(storageError(TRANSACTION_OPERATION, undefined, checkedKey.failure)))
      return
    }
    const validKey = checkedKey.success
    const validOperation = StorageOperation(operation)
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
      settle(Effect.fail(failureFor(validOperation, validKey, pendingFailure.cause)))
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
                  operationWithSuffix(validOperation, ':incomplete'),
                  validKey,
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
