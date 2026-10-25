import { Result } from 'effect'
import { StorageError } from './errors.js'
import {
  makeIdbExceptionName,
  makeIdbIndexName,
  makeIdbStoreName,
  makeIdbVersion,
  type IdbDatabaseName,
  type IdbFactory,
  type IdbIndexName,
  type IdbStoreName,
  type IdbVersion,
} from './indexeddb-surface.js'

/** The one object store this adapter creates. Deliberately not `chunks`/`metadata`. */
export const SAVE_STORE_NAME: IdbStoreName = makeIdbStoreName('saves')

/** The index that makes `keys` answer in insertion order rather than key order. */
export const INSERTION_INDEX_NAME: IdbIndexName = makeIdbIndexName('by-insertion')

/** The version of the IndexedDB store layout, not of any saved format. */
export const STORE_LAYOUT_VERSION: IdbVersion = makeIdbVersion(2)

/** The marker appended to a storage operation when the medium is full. */
export const QUOTA_EXCEEDED_MARKER = ':quota-exceeded'

const QUOTA_EXCEEDED_NAME = makeIdbExceptionName('QuotaExceededError')

export type IndexedDbStorageOptions = {
  readonly factory: IdbFactory
  readonly databaseName: IdbDatabaseName
}

export const isQuotaExceeded = (error: StorageError): boolean =>
  error.operation.endsWith(QUOTA_EXCEEDED_MARKER)

export const isQuotaExceededCause = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const observedName = Result.try({ try: () => Reflect.get(cause, 'name'), catch: (failure) => failure })
  if (Result.isFailure(observedName)) return false
  const name = makeIdbExceptionName.result(observedName.success)
  return Result.isSuccess(name) && name.success === QUOTA_EXCEEDED_NAME
}
