/** The IndexedDB-backed implementation of `StoragePort`. */
import { Effect, Layer, Option, Result, Scope } from 'effect'
import type { SaveEnvelope } from './envelope.js'
import { StorageError } from './errors.js'
import {
  INSERTION_INDEX_NAME,
  type IndexedDbStorageOptions,
} from './indexeddb-layout.js'
import { asRecord, readEnvelope, readKeys, readSequence } from './indexeddb-records.js'
import { openDatabase, runTransaction } from './indexeddb-runtime.js'
import type { IdbDatabase } from './indexeddb-surface.js'
import { sameSaveEnvelope } from './integrity.js'
import type { SaveKey } from './save-key.js'
import { StoragePort, type StorageService } from './storage-port.js'

export {
  INSERTION_INDEX_NAME,
  QUOTA_EXCEEDED_MARKER,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
  isQuotaExceeded,
} from './indexeddb-layout.js'
export type { IndexedDbStorageOptions } from './indexeddb-layout.js'

const conflictError = (key: SaveKey): StorageError =>
  new StorageError({ operation: 'indexeddb.commitBatch:conflict', key })

const matchesExpected = (record: unknown, expected: Option.Option<SaveEnvelope>): boolean => {
  if (Option.isNone(expected)) return record === undefined
  if (record === undefined) return false
  const envelope = readEnvelope(record)
  return Result.isSuccess(envelope) && sameSaveEnvelope(envelope.success, expected.value)
}

const serviceFor = (database: IdbDatabase): StorageService => ({
  get: (key) =>
    runTransaction<Option.Option<SaveEnvelope>>(
      database,
      'readonly',
      'indexeddb.get',
      key,
      (store, deliver, onResult, fail) => {
        onResult(store.get(key), (record) => {
          if (record === undefined) {
            deliver(Option.none())
            return
          }
          const envelope = readEnvelope(record)
          if (Result.isFailure(envelope)) {
            fail(envelope.failure)
            return
          }
          deliver(Option.some(envelope.success))
        })
      },
    ),

  put: (key, envelope) =>
    runTransaction<void>(database, 'readwrite', 'indexeddb.put', key, (store, deliver, onResult, fail) => {
      onResult(store.get(key), (existing) => {
        const existingSeq = readSequence(existing, 'seq')
        if (Result.isFailure(existingSeq)) {
          fail(existingSeq.failure)
          return
        }
        if (existingSeq.success !== undefined) {
          store.put({ key, seq: existingSeq.success, envelope })
          deliver(undefined)
          return
        }
        onResult(store.index(INSERTION_INDEX_NAME).openCursor(null, 'prev'), (cursor) => {
          const highest = readSequence(asRecord(cursor)?.['value'], 'seq')
          if (Result.isFailure(highest)) {
            fail(highest.failure)
            return
          }
          store.put({ key, seq: highest.success === undefined ? 0 : highest.success + 1, envelope })
          deliver(undefined)
        })
      })
    }),

  remove: (key) =>
    runTransaction<void>(database, 'readwrite', 'indexeddb.remove', key, (store, deliver, onResult) => {
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
          (store, deliver, onResult, fail) => {
            const apply = (index: number, nextSequence: number): void => {
              const mutation = mutations[index]
              if (mutation === undefined) {
                deliver(undefined)
                return
              }
              if (mutation._tag === 'Remove') {
                const expected = mutation.expected
                if (expected === undefined) {
                  onResult(store.delete(mutation.key), () => apply(index + 1, nextSequence))
                  return
                }
                onResult(store.get(mutation.key), (existing) => {
                  if (!matchesExpected(existing, expected)) {
                    fail(conflictError(mutation.key))
                    return
                  }
                  onResult(store.delete(mutation.key), () => apply(index + 1, nextSequence))
                })
                return
              }
              const expected = mutation.expected
              onResult(store.get(mutation.key), (existing) => {
                if (expected !== undefined && !matchesExpected(existing, expected)) {
                  fail(conflictError(mutation.key))
                  return
                }
                const existingSequence = readSequence(existing, 'seq')
                if (Result.isFailure(existingSequence)) {
                  fail(existingSequence.failure)
                  return
                }
                const sequence = existingSequence.success ?? nextSequence
                onResult(store.put({ key: mutation.key, seq: sequence, envelope: mutation.envelope }), () =>
                  apply(index + 1, existingSequence.success === undefined ? nextSequence + 1 : nextSequence),
                )
              })
            }
            onResult(store.index(INSERTION_INDEX_NAME).openCursor(null, 'prev'), (cursor) => {
              const highest = readSequence(asRecord(cursor)?.['value'], 'seq')
              if (Result.isFailure(highest)) {
                fail(highest.failure)
                return
              }
              apply(0, highest.success === undefined ? 0 : highest.success + 1)
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
          (store, deliver, onResult, fail) => {
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
                  if (Result.isFailure(envelope)) {
                    fail(envelope.failure)
                    return
                  }
                  results.push(Option.some(envelope.success))
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
    (store, deliver, onResult, fail) => {
      onResult(store.index(INSERTION_INDEX_NAME).getAllKeys(), (result) => {
        const keys = readKeys(result)
        if (Result.isFailure(keys)) {
          fail(keys.failure)
          return
        }
        deliver(keys.success)
      })
    },
  ),
})

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
  Layer.effect(StoragePort, makeIndexedDbStorage(options))
