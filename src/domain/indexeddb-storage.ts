/** The IndexedDB-backed implementation of `StoragePort`. */
import { Effect, Layer, Option, Scope } from 'effect'
import type { SaveEnvelope } from './envelope.js'
import { StorageError } from './errors.js'
import {
  INSERTION_INDEX_NAME,
  SAVE_STORE_NAME,
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

const matchesExpected = (record: unknown, expected: Option.Option<SaveEnvelope>): boolean => {
  if (Option.isNone(expected)) return record === undefined
  try {
    const envelope = readEnvelope(record)
    return envelope !== undefined && sameSaveEnvelope(envelope, expected.value)
  } catch {
    return false
  }
}

const assertExpected = (key: SaveKey, record: unknown, expected: Option.Option<SaveEnvelope>): void => {
  if (!matchesExpected(record, expected)) {
    throw new StorageError({ operation: 'indexeddb.commitBatch:conflict', key })
  }
}

const serviceFor = (database: IdbDatabase): StorageService => ({
  get: (key) =>
    runTransaction<Option.Option<SaveEnvelope>>(
      database,
      'readonly',
      'indexeddb.get',
      key,
      (store, deliver, onResult) => {
        onResult(store.get(key), (record) => {
          if (record === undefined) {
            deliver(Option.none())
            return
          }
          const envelope = readEnvelope(record)
          if (envelope === undefined) {
            throw new TypeError(
              `${SAVE_STORE_NAME} holds a record at "${key}" that this adapter did not write`,
            )
          }
          deliver(Option.some(envelope))
        })
      },
    ),

  put: (key, envelope) =>
    runTransaction<void>(database, 'readwrite', 'indexeddb.put', key, (store, deliver, onResult) => {
      onResult(store.get(key), (existing) => {
        const existingSeq = readSequence(existing, 'seq')
        if (existingSeq !== undefined) {
          store.put({ key, seq: existingSeq, envelope })
          deliver(undefined)
          return
        }
        onResult(store.index(INSERTION_INDEX_NAME).openCursor(null, 'prev'), (cursor) => {
          const highest = readSequence(asRecord(cursor)?.['value'], 'seq')
          store.put({ key, seq: highest === undefined ? 0 : highest + 1, envelope })
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
          (store, deliver, onResult) => {
            const apply = (index: number, nextSequence: number): void => {
              const mutation = mutations[index]
              if (mutation === undefined) {
                deliver(undefined)
                return
              }
              if (mutation._tag === 'Remove') {
                if (mutation.expected === undefined) {
                  onResult(store.delete(mutation.key), () => apply(index + 1, nextSequence))
                  return
                }
                const expected = mutation.expected
                onResult(store.get(mutation.key), (existing) => {
                  assertExpected(mutation.key, existing, expected)
                  onResult(store.delete(mutation.key), () => apply(index + 1, nextSequence))
                })
                return
              }
              onResult(store.get(mutation.key), (existing) => {
                if (mutation.expected !== undefined) {
                  assertExpected(mutation.key, existing, mutation.expected)
                }
                const existingSequence = readSequence(existing, 'seq')
                const sequence = existingSequence ?? nextSequence
                onResult(store.put({ key: mutation.key, seq: sequence, envelope: mutation.envelope }), () =>
                  apply(index + 1, existingSequence === undefined ? nextSequence + 1 : nextSequence),
                )
              })
            }

            onResult(store.index(INSERTION_INDEX_NAME).openCursor(null, 'prev'), (cursor) => {
              const highest = readSequence(asRecord(cursor)?.['value'], 'seq')
              apply(0, highest === undefined ? 0 : highest + 1)
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
          (store, deliver, onResult) => {
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
                  if (envelope === undefined) {
                    throw new TypeError(
                      `${SAVE_STORE_NAME} holds a record at "${key}" that this adapter did not write`,
                    )
                  }
                  results.push(Option.some(envelope))
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
    (store, deliver, onResult) => {
      onResult(store.index(INSERTION_INDEX_NAME).getAllKeys(), (result) => {
        deliver(readKeys(result))
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
  Layer.scoped(StoragePort, makeIndexedDbStorage(options))
