import { Result, Schema } from 'effect'
import {
  IndexedDbFieldName,
  StorageOperation,
  StorageSequence,
  type IndexedDbFieldName as IndexedDbFieldNameType,
  type StorageSequence as StorageSequenceType,
} from './brand-types.js'
import { SaveEnvelopeSchema, type SaveEnvelope } from './envelope.js'
import { SaveDecodeError, StorageError } from './errors.js'
import { INSERTION_INDEX_NAME, SAVE_STORE_NAME } from './indexeddb-layout.js'
import { SaveKey } from './save-key.js'
import type { SaveKey as SaveKeyType } from './save-key.js'

const RECORD_OPERATION = StorageOperation('indexeddb.record')
const SEQUENCE_OPERATION = StorageOperation('indexeddb.sequence')
const KEYS_OPERATION = StorageOperation('indexeddb.keys')

const isRecord = (value: unknown): value is Readonly<Record<IndexedDbFieldNameType, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const RECORD_KEY_FIELD = IndexedDbFieldName('key')
const RECORD_ENVELOPE_FIELD = IndexedDbFieldName('envelope')

export const asRecord = (
  value: unknown,
): Result.Result<Readonly<Record<IndexedDbFieldNameType, unknown>>, StorageError> => {
  const inspected = Result.try({
    try: () => (isRecord(value) ? { _tag: 'record' as const, value } : { _tag: 'malformed' as const }),
    catch: (cause) => new StorageError({ operation: RECORD_OPERATION, cause }),
  })
  if (Result.isFailure(inspected)) return Result.fail(inspected.failure)
  return inspected.success._tag === 'record'
    ? Result.succeed(inspected.success.value)
    : Result.fail(new StorageError({ operation: RECORD_OPERATION, cause: 'stored record is malformed' }))
}

export const readSequence = (
  source: unknown,
  field: IndexedDbFieldNameType | 'seq',
): Result.Result<StorageSequenceType | undefined, StorageError> => {
  const validField = IndexedDbFieldName.result(field)
  if (Result.isFailure(validField)) {
    return Result.fail(new StorageError({ operation: SEQUENCE_OPERATION, cause: validField.failure }))
  }
  if (source === undefined) return Result.succeed(undefined)
  const record = asRecord(source)
  if (Result.isFailure(record)) {
    return Result.fail(new StorageError({ operation: SEQUENCE_OPERATION, cause: record.failure.cause }))
  }
  const captured = Result.try({
    try: () => record.success[validField.success],
    catch: (cause) => new StorageError({ operation: SEQUENCE_OPERATION, cause }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const value = captured.success
  if (value === undefined) {
    return Result.fail(new StorageError({ operation: SEQUENCE_OPERATION, cause: 'stored sequence is missing' }))
  }
  if (typeof value !== 'number') {
    return Result.fail(
      new StorageError({ operation: SEQUENCE_OPERATION, cause: 'stored sequence is malformed' }),
    )
  }
  const sequence = StorageSequence.result(value)
  return Result.isFailure(sequence)
    ? Result.fail(new StorageError({ operation: SEQUENCE_OPERATION, cause: 'stored sequence is malformed' }))
    : Result.succeed(sequence.success)
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
  const source = asRecord(record)
  if (Result.isFailure(source)) {
    return Result.fail(
      new SaveDecodeError({
        format: 'unknown',
        version: 0,
        reason: 'stored save record is malformed',
        cause: source.failure,
      }),
    )
  }
  const captured = Result.try({
    try: () => ({
      key: source.success[RECORD_KEY_FIELD],
      envelope: source.success[RECORD_ENVELOPE_FIELD],
    }),
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
  if (fields.key === undefined || fields.envelope === undefined) {
    return Result.fail(
      new SaveDecodeError({
        format: 'unknown',
        version: 0,
        reason: 'stored save record is malformed',
      }),
    )
  }
  if (typeof fields.key !== 'string') {
    return Result.fail(
      new SaveDecodeError({
        format: 'unknown',
        version: 0,
        reason: 'stored save record key is malformed',
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
    catch: (cause) => new StorageError({ operation: KEYS_OPERATION, cause }),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  if (captured.success === undefined) {
    return Result.fail(
      new StorageError({
        operation: KEYS_OPERATION,
        cause: `${INSERTION_INDEX_NAME} did not return a list of keys`,
      }),
    )
  }
  const keys: Array<SaveKeyType> = []
  for (const entry of captured.success) {
    if (typeof entry !== 'string') {
      return Result.fail(
        new StorageError({
          operation: KEYS_OPERATION,
          cause: `${SAVE_STORE_NAME} returned a non-string key`,
        }),
      )
    }
    const key = SaveKey.result(entry)
    if (Result.isFailure(key)) {
      return Result.fail(new StorageError({ operation: KEYS_OPERATION, cause: key.failure }))
    }
    keys.push(key.success)
  }
  return Result.succeed(keys)
}
