/** The IndexedDB-backed implementation of `StoragePort`. */
import { Effect, Layer, Option, Result, Scope } from 'effect'
import { IndexedDbFieldName, type CanonicalizationIssue } from './brand-types.js'
import type { SaveEnvelope } from './envelope.js'
import { StorageError, type SaveDecodeError } from './errors.js'
import {
  INSERTION_INDEX_NAME,
  type IndexedDbStorageOptions,
} from './indexeddb-layout.js'
import { asRecord, readEnvelope, readKeys, readSequence } from './indexeddb-records.js'
import { openDatabase, runTransaction } from './indexeddb-runtime.js'
import type { IdbDatabase } from './indexeddb-surface.js'
import { sameSaveEnvelope } from './integrity.js'
import type { SaveKey } from './save-key.js'
import { StoragePort, type StorageMutation, type StorageService } from './storage-port.js'

export {
  INSERTION_INDEX_NAME,
  QUOTA_EXCEEDED_MARKER,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
  isQuotaExceeded,
} from './indexeddb-layout.js'
export type { IndexedDbStorageOptions } from './indexeddb-layout.js'

const CURSOR_VALUE_FIELD = IndexedDbFieldName('value')

const conflictError = (key: SaveKey): StorageError =>
  new StorageError({ operation: 'indexeddb.commitBatch:conflict', key })

const snapshotDenseArray = <A>(value: unknown, operation: string): Result.Result<ReadonlyArray<A>, StorageError> => {
  const captured = Result.try({
    try: () => {
      if (!Array.isArray(value)) return undefined
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
      const length = lengthDescriptor?.value
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return undefined
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== length + 1) return undefined
      for (const key of ownKeys) {
        if (key === 'length') continue
        if (typeof key !== 'string') return undefined
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) return undefined
      }
      const values: A[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) return undefined
        values.push(descriptor.value)
      }
      return values
    },
    catch: (cause) => new StorageError({ operation, cause }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  return captured.success === undefined
    ? Result.fail(new StorageError({ operation, cause: 'batch input must be a dense array without undefined entries' }))
    : Result.succeed(captured.success)
}

const matchesExpected = (
  record: unknown,
  expected: Option.Option<SaveEnvelope>,
): Result.Result<boolean, CanonicalizationIssue | SaveDecodeError> => {
  if (Option.isNone(expected)) return Result.succeed(record === undefined)
  if (record === undefined) return Result.succeed(false)
  const envelope = readEnvelope(record)
  return Result.isFailure(envelope)
    ? Result.fail(envelope.failure)
    : sameSaveEnvelope(envelope.success, expected.value)
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
          if (cursor === null) {
            store.put({ key, seq: 0, envelope })
            deliver(undefined)
            return
          }
          const cursorRecord = asRecord(cursor)
          if (Result.isFailure(cursorRecord)) {
            fail(cursorRecord.failure)
            return
          }
          const cursorValue = Result.try({
            try: () => cursorRecord.success[CURSOR_VALUE_FIELD],
            catch: (cause) => new StorageError({ operation: 'indexeddb.sequence', cause }),
          })
          if (Result.isFailure(cursorValue)) {
            fail(cursorValue.failure)
            return
          }
          if (cursorValue.success === undefined) {
            fail(new StorageError({ operation: 'indexeddb.sequence', cause: 'cursor value is missing' }))
            return
          }
          const highest = readSequence(cursorValue.success, 'seq')
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
    Effect.suspend(() => {
      const snapshot = snapshotDenseArray<StorageMutation>(mutations, 'indexeddb.commitBatch')
      if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
      const batch = snapshot.success
      if (batch.length === 0) return Effect.void
      return runTransaction<void>(
        database,
        'readwrite',
        'indexeddb.commitBatch',
        undefined,
        (store, deliver, onResult, fail) => {
          const apply = (index: number, nextSequence: number): void => {
            if (index === batch.length) {
              deliver(undefined)
              return
            }
            const mutation = batch[index]
            if (mutation === undefined) {
              fail(new StorageError({ operation: 'indexeddb.commitBatch', cause: 'batch snapshot is incomplete' }))
              return
            }
            if (mutation._tag === 'Remove') {
              const expected = mutation.expected
              if (expected === undefined) {
                onResult(store.delete(mutation.key), () => apply(index + 1, nextSequence))
                return
              }
              onResult(store.get(mutation.key), (existing) => {
                const matches = matchesExpected(existing, expected)
                if (Result.isFailure(matches)) {
                  fail(new StorageError({ operation: 'indexeddb.commitBatch', key: mutation.key, cause: matches.failure }))
                  return
                }
                if (!matches.success) {
                  fail(conflictError(mutation.key))
                  return
                }
                onResult(store.delete(mutation.key), () => apply(index + 1, nextSequence))
              })
              return
            }
            const expected = mutation.expected
            onResult(store.get(mutation.key), (existing) => {
              if (expected !== undefined) {
                const matches = matchesExpected(existing, expected)
                if (Result.isFailure(matches)) {
                  fail(new StorageError({ operation: 'indexeddb.commitBatch', key: mutation.key, cause: matches.failure }))
                  return
                }
                if (!matches.success) {
                  fail(conflictError(mutation.key))
                  return
                }
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
            if (cursor === null) {
              apply(0, 0)
              return
            }
            const cursorRecord = asRecord(cursor)
            if (Result.isFailure(cursorRecord)) {
              fail(cursorRecord.failure)
              return
            }
            const cursorValue = Result.try({
              try: () => cursorRecord.success[CURSOR_VALUE_FIELD],
              catch: (cause) => new StorageError({ operation: 'indexeddb.sequence', cause }),
            })
            if (Result.isFailure(cursorValue)) {
              fail(cursorValue.failure)
              return
            }
            if (cursorValue.success === undefined) {
              fail(new StorageError({ operation: 'indexeddb.sequence', cause: 'cursor value is missing' }))
              return
            }
            const highest = readSequence(cursorValue.success, 'seq')
            if (Result.isFailure(highest)) {
              fail(highest.failure)
              return
            }
            apply(0, highest.success === undefined ? 0 : highest.success + 1)
          })
        },
      )
    }),

  readBatch: (keys) =>
    Effect.suspend(() => {
      const snapshot = snapshotDenseArray<SaveKey>(keys, 'indexeddb.readBatch')
      if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
      const batch = snapshot.success
      if (batch.length === 0) return Effect.succeed([])
      return runTransaction<ReadonlyArray<Option.Option<SaveEnvelope>>>(
        database,
        'readonly',
        'indexeddb.readBatch',
        undefined,
        (store, deliver, onResult, fail) => {
          const results: Array<Option.Option<SaveEnvelope>> = []
          const read = (index: number): void => {
            if (index === batch.length) {
              deliver(results)
              return
            }
            const key = batch[index]
            if (key === undefined) {
              fail(new StorageError({ operation: 'indexeddb.readBatch', cause: 'batch snapshot is incomplete' }))
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
      )
    }),

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
