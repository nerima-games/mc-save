import { Result, Schema } from 'effect'
import { SaveEnvelopeSchema, type SaveEnvelope } from './envelope.js'
import { SaveDecodeError, StorageError } from './errors.js'
import { INSERTION_INDEX_NAME, SAVE_STORE_NAME } from './indexeddb-layout.js'
import { SaveKey } from './save-key.js'
import type { SaveKey as SaveKeyType } from './save-key.js'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

export const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  isRecord(value) ? value : undefined

export const readSequence = (source: unknown, field: string): Result.Result<number | undefined, StorageError> => {
  if (source === undefined) return Result.succeed(undefined)
  const record = asRecord(source)
  if (record === undefined || Array.isArray(source)) {
    return Result.fail(new StorageError({ operation: 'indexeddb.sequence', cause: 'stored record is malformed' }))
  }
  const captured = Result.try({
    try: () => record[field],
    catch: (cause) => new StorageError({ operation: 'indexeddb.sequence', cause }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const value = captured.success
  if (value === undefined) {
    return Result.fail(new StorageError({ operation: 'indexeddb.sequence', cause: 'stored sequence is missing' }))
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Result.succeed(value)
    : Result.fail(new StorageError({ operation: 'indexeddb.sequence', cause: 'stored sequence is malformed' }))
}

const decodeSaveEnvelope = (value: unknown): Result.Result<SaveEnvelope, SaveDecodeError> => {
  const decoded = Result.try({
    try: () => Schema.decodeUnknownResult(SaveEnvelopeSchema)(value),
    catch: (cause) =>
      new SaveDecodeError({
        format: 'unknown',
        version: 0,
        reason: 'stored save envelope could not be read',
        cause,
      }),
  })
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  if (Result.isFailure(decoded.success)) {
    return Result.fail(
      new SaveDecodeError({
        format: 'unknown',
        version: 0,
        reason: 'stored value is not a well-formed save envelope',
        cause: decoded.success.failure,
      }),
    )
  }
  return Result.succeed(decoded.success.success)
}

export const readEnvelope = (record: unknown): Result.Result<SaveEnvelope, SaveDecodeError> => {
  const captured = Result.try({
    try: () => {
      const fields = asRecord(record)
      if (fields === undefined) return undefined
      return { key: fields['key'], envelope: fields['envelope'] }
    },
    catch: (cause) =>
      new SaveDecodeError({
        format: 'unknown',
        version: 0,
        reason: 'stored save record fields could not be read',
        cause,
      }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const fields = captured.success
  if (fields === undefined || typeof fields.key !== 'string' || fields.envelope === undefined) {
    return Result.fail(
      new SaveDecodeError({
        format: 'unknown',
        version: 0,
        reason: 'stored save record is malformed',
      }),
    )
  }
  const key = SaveKey.result(fields.key)
  if (Result.isFailure(key)) {
    return Result.fail(
      new SaveDecodeError({
        format: 'unknown',
        version: 0,
        reason: 'stored save record key is malformed',
        cause: key.failure,
      }),
    )
  }
  return decodeSaveEnvelope(fields.envelope)
}

export const readKeys = (result: unknown): Result.Result<ReadonlyArray<SaveKeyType>, StorageError> => {
  const captured = Result.try({
    try: () => {
      if (!Array.isArray(result)) return undefined
      const length = result.length
      if (!Number.isSafeInteger(length) || length < 0) return undefined
      return Array.from({ length }, (_, index) => result[index])
    },
    catch: (cause) => new StorageError({ operation: 'indexeddb.keys', cause }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  if (captured.success === undefined) {
    return Result.fail(
      new StorageError({
        operation: 'indexeddb.keys',
        cause: `${INSERTION_INDEX_NAME} did not return a list of keys`,
      }),
    )
  }
  const keys: Array<SaveKeyType> = []
  for (const entry of captured.success) {
    if (typeof entry !== 'string') {
      return Result.fail(
        new StorageError({
          operation: 'indexeddb.keys',
          cause: `${SAVE_STORE_NAME} returned a non-string key`,
        }),
      )
    }
    const key = SaveKey.result(entry)
    if (Result.isFailure(key)) {
      return Result.fail(new StorageError({ operation: 'indexeddb.keys', cause: key.failure }))
    }
    keys.push(key.success)
  }
  return Result.succeed(keys)
}
