/** The IndexedDB-backed implementation of `StoragePort`. */
import { Effect, Layer, Option, Result, Schema, Scope } from 'effect'
import { StorageSequence, type CanonicalizationIssue } from './brand-types.js'
import { SaveEnvelopeSchema, type SaveEnvelope } from './envelope.js'
import { StorageError, type SaveDecodeError } from './errors.js'
import {
  INSERTION_INDEX_NAME,
  type IndexedDbStorageOptions,
} from './indexeddb-layout.js'
import { readEnvelope, readKeys, readSequence } from './indexeddb-records.js'
import { openDatabase, runTransaction } from './indexeddb-runtime.js'
import type { IdbDatabase } from './indexeddb-surface.js'
import { sameSaveEnvelope } from './integrity.js'
import { SaveKey as SaveKeyConstructor, type SaveKey } from './save-key.js'
import { StoragePort, type StorageMutation, type StorageService } from './storage-port.js'

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

const sequenceResult = (value: unknown): Result.Result<StorageSequence, StorageError> => {
  if (typeof value !== 'number') {
    return Result.fail(new StorageError({ operation: 'indexeddb.sequence', cause: 'stored sequence is malformed' }))
  }
  return Result.mapError(
    StorageSequence.result(value),
    (cause) => new StorageError({ operation: 'indexeddb.sequence', cause }),
  )
}

const sequenceFromCursor = (cursor: unknown): Result.Result<StorageSequence, StorageError> => {
  if (typeof cursor !== 'object' || cursor === null) {
    return Result.fail(new StorageError({ operation: 'indexeddb.sequence', cause: 'cursor is malformed' }))
  }
  const captured = Result.try({
    try: () => Reflect.get(cursor, 'key'),
    catch: (cause) => new StorageError({ operation: 'indexeddb.sequence', cause }),
  })
  return Result.isFailure(captured) ? Result.fail(captured.failure) : sequenceResult(captured.success)
}

const decodeSaveEnvelope = (
  value: unknown,
  operation: string,
  key: SaveKey,
): Result.Result<SaveEnvelope, StorageError> => {
  const decoded = Result.try({
    try: () => Schema.decodeUnknownResult(SaveEnvelopeSchema)(value),
    catch: (cause) => new StorageError({ operation, key, cause }),
  })
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  return Result.isFailure(decoded.success)
    ? Result.fail(new StorageError({ operation, key, cause: decoded.success.failure }))
    : Result.succeed(decoded.success.success)
}

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
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.value === undefined ||
          descriptor.value === null
        ) {
          return undefined
        }
        values.push(descriptor.value)
      }
      return values
    },
    catch: (cause) => new StorageError({ operation, cause }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  return captured.success === undefined
    ? Result.fail(new StorageError({ operation, cause: 'batch input must be a dense array without null or undefined entries' }))
    : Result.succeed(captured.success)
}

const snapshotMutationBatch = (
  mutations: ReadonlyArray<unknown>,
  operation: string,
): Result.Result<ReadonlyArray<StorageMutation>, StorageError> => {
  let failure: StorageError | undefined
  let failureKey: SaveKey | undefined
  const captured = Result.try({
    try: () => {
      const normalized: StorageMutation[] = []
      for (const mutation of mutations) {
        failureKey = undefined
        if (typeof mutation !== 'object' || mutation === null || Array.isArray(mutation)) return false
        const tag = Reflect.get(mutation, '_tag')
        if (tag !== 'Put' && tag !== 'Remove') return false
        const key = SaveKeyConstructor.result(Reflect.get(mutation, 'key'))
        if (Result.isFailure(key)) return false
        failureKey = key.success
        const hasExpected = Reflect.has(mutation, 'expected')
        const rawExpected = Reflect.get(mutation, 'expected')
        if (hasExpected && !Option.isOption(rawExpected)) return false
        let expected: Option.Option<SaveEnvelope> | undefined
        if (hasExpected) {
          if (Option.isNone(rawExpected)) {
            expected = Option.none()
          } else {
            const decodedExpected = Schema.decodeUnknownResult(SaveEnvelopeSchema)(rawExpected.value)
            if (Result.isFailure(decodedExpected)) {
              failure = new StorageError({ operation, key: key.success, cause: decodedExpected.failure })
              return false
            }
            expected = Option.some(decodedExpected.success)
          }
        }
        if (tag === 'Remove') {
          normalized.push(expected === undefined ? { _tag: 'Remove', key: key.success } : { _tag: 'Remove', key: key.success, expected })
          continue
        }
        const decodedEnvelope = Schema.decodeUnknownResult(SaveEnvelopeSchema)(Reflect.get(mutation, 'envelope'))
        if (Result.isFailure(decodedEnvelope)) {
          failure = new StorageError({ operation, key: key.success, cause: decodedEnvelope.failure })
          return false
        }
        normalized.push(
          expected === undefined
            ? { _tag: 'Put', key: key.success, envelope: decodedEnvelope.success }
            : { _tag: 'Put', key: key.success, envelope: decodedEnvelope.success, expected },
        )
      }
      return normalized
    },
    catch: (cause) => new StorageError({ operation, cause }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  return captured.success !== false
    ? Result.succeed(captured.success)
    : Result.fail(
        failure ?? new StorageError({
          operation,
          ...(failureKey === undefined ? {} : { key: failureKey }),
          cause: 'batch contains an invalid mutation',
        }),
      )
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
    Effect.suspend(() => {
      const decodedEnvelope = decodeSaveEnvelope(envelope, 'indexeddb.put', key)
      if (Result.isFailure(decodedEnvelope)) return Effect.fail(decodedEnvelope.failure)
      return runTransaction<void>(database, 'readwrite', 'indexeddb.put', key, (store, deliver, onResult, fail) => {
        onResult(store.get(key), (existing) => {
          const existingSeq = readSequence(existing)
          if (Result.isFailure(existingSeq)) {
            fail(existingSeq.failure)
            return
          }
          if (existingSeq.success !== undefined) {
            store.put({ key, seq: existingSeq.success, envelope: decodedEnvelope.success })
            deliver(undefined)
            return
          }
          onResult(store.index(INSERTION_INDEX_NAME).openCursor(null, 'prev'), (cursor) => {
            if (cursor === null) {
              store.put({ key, seq: 0, envelope: decodedEnvelope.success })
              deliver(undefined)
              return
            }
            const highest = sequenceFromCursor(cursor)
            if (Result.isFailure(highest)) {
              fail(highest.failure)
              return
            }
            const nextSequence = sequenceResult(highest.success + 1)
            if (Result.isFailure(nextSequence)) {
              fail(nextSequence.failure)
              return
            }
            store.put({ key, seq: nextSequence.success, envelope: decodedEnvelope.success })
            deliver(undefined)
          })
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
      const snapshot = snapshotDenseArray<unknown>(mutations, 'indexeddb.commitBatch')
      if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
      const normalized = snapshotMutationBatch(snapshot.success, 'indexeddb.commitBatch')
      if (Result.isFailure(normalized)) return Effect.fail(normalized.failure)
      const batch = normalized.success
      if (batch.length === 0) return Effect.void
      return runTransaction<void>(
        database,
        'readwrite',
        'indexeddb.commitBatch',
        undefined,
        (store, deliver, onResult, fail) => {
          const pending = batch[Symbol.iterator]()
          const apply = (nextSequence: number): void => {
            const next = pending.next()
            if (next.done) {
              deliver(undefined)
              return
            }
            const mutation = next.value
            if (mutation._tag === 'Remove') {
              const expected = mutation.expected
              if (expected === undefined) {
                onResult(store.delete(mutation.key), () => apply(nextSequence))
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
                onResult(store.delete(mutation.key), () => apply(nextSequence))
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
              const existingSequence = readSequence(existing)
              if (Result.isFailure(existingSequence)) {
                fail(existingSequence.failure)
                return
              }
              const sequence = sequenceResult(
                existingSequence.success === undefined ? nextSequence : existingSequence.success,
              )
              if (Result.isFailure(sequence)) {
                fail(sequence.failure)
                return
              }
              onResult(store.put({ key: mutation.key, seq: sequence.success, envelope: mutation.envelope }), () =>
                apply(existingSequence.success === undefined ? nextSequence + 1 : nextSequence),
              )
            })
          }
          onResult(store.index(INSERTION_INDEX_NAME).openCursor(null, 'prev'), (cursor) => {
            if (cursor === null) {
              apply(0)
              return
            }
            const highest = sequenceFromCursor(cursor)
            if (Result.isFailure(highest)) {
              fail(highest.failure)
              return
            }
            apply(highest.success + 1)
          })
        },
      )
    }),

  readBatch: (keys) =>
    Effect.suspend(() => {
      const snapshot = snapshotDenseArray<SaveKey>(keys, 'indexeddb.readBatch')
      if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
      const batch = snapshot.success
      for (const key of batch) {
        const checked = SaveKeyConstructor.result(key)
        if (Result.isFailure(checked)) {
          return Effect.fail(new StorageError({ operation: 'indexeddb.readBatch', cause: checked.failure }))
        }
      }
      if (batch.length === 0) return Effect.succeed([])
      return runTransaction<ReadonlyArray<Option.Option<SaveEnvelope>>>(
        database,
        'readonly',
        'indexeddb.readBatch',
        undefined,
        (store, deliver, onResult, fail) => {
          const results: Array<Option.Option<SaveEnvelope>> = []
          const pending = batch[Symbol.iterator]()
          const read = (): void => {
            const next = pending.next()
            if (next.done) {
              deliver(results)
              return
            }
            const key = next.value
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
              read()
            })
          }
          read()
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
