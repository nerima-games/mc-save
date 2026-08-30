import { StorageError } from './errors.js'
import type { IdbFactory } from './indexeddb-surface.js'

/** The one object store this adapter creates. Deliberately not `chunks`/`metadata`. */
export const SAVE_STORE_NAME = 'saves'

/** The index that makes `keys` answer in insertion order rather than key order. */
export const INSERTION_INDEX_NAME = 'by-insertion'

/** The version of the IndexedDB store layout, not of any saved format. */
export const STORE_LAYOUT_VERSION = 2

/** The marker appended to a storage operation when the medium is full. */
export const QUOTA_EXCEEDED_MARKER = ':quota-exceeded'

const QUOTA_EXCEEDED_NAME = 'QuotaExceededError'

export type IndexedDbStorageOptions = {
  readonly factory: IdbFactory
  readonly databaseName: string
}

export const isQuotaExceeded = (error: StorageError): boolean =>
  error.operation.endsWith(QUOTA_EXCEEDED_MARKER)

export const isQuotaExceededCause = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null || !('name' in cause)) {
    return false
  }
  return cause.name === QUOTA_EXCEEDED_NAME
}
