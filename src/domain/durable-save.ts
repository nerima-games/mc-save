/* eslint-disable no-bitwise -- UTF-8 encoding and FNV-1a are byte-level algorithms. */
import { Effect, Option, Schema } from 'effect'
import { isFromFuture, type SaveEnvelope, SaveEnvelopeSchema } from './envelope.js'
import { SaveDecodeError, StorageError } from './errors.js'
import { decodeSave, encodeSave, type SaveFormat } from './format.js'
import { durablePreviousKey } from './durable-key.js'
import type { SaveKey } from './save-key.js'
import { StoragePort } from './storage-port.js'
import {
  DEFAULT_MAX_SAVE_BYTES,
  sealAndValidateSaveEnvelope,
  validateSaveEnvelope,
} from './integrity.js'

export { DEFAULT_MAX_SAVE_BYTES, sealSaveEnvelope, validateSaveEnvelope } from './integrity.js'

interface SaveLock {
  readonly semaphore: Effect.Semaphore
  users: number
}

const saveLocks = new WeakMap<object, Map<string, SaveLock>>()

const acquireLock = (storage: object, key: SaveKey): SaveLock => {
  let locks = saveLocks.get(storage)
  if (locks === undefined) {
    locks = new Map()
    saveLocks.set(storage, locks)
  }
  const existing = locks.get(key)
  if (existing !== undefined) {
    existing.users += 1
    return existing
  }
  const created = { semaphore: Effect.runSync(Effect.makeSemaphore(1)), users: 1 }
  locks.set(key, created)
  return created
}

const releaseLock = (storage: object, key: SaveKey, lock: SaveLock): void => {
  lock.users -= 1
  if (lock.users !== 0) return
  const locks = saveLocks.get(storage)!
  locks.delete(key)
  if (locks.size === 0) saveLocks.delete(storage)
}

const readStoredEnvelope = <A, I>(
  format: SaveFormat<A, I>,
  stored: unknown,
  maxBytes: number,
): Effect.Effect<SaveEnvelope, SaveDecodeError> =>
  Schema.decodeUnknown(SaveEnvelopeSchema)(stored).pipe(
    Effect.mapError(
      (cause) =>
        new SaveDecodeError({
          format: format.name,
          version: 0,
          reason: 'stored value is not a well-formed save envelope',
          cause,
        }),
    ),
    Effect.flatMap((envelope) => validateSaveEnvelope(envelope, maxBytes)),
  )

const decodeStored = <A, I>(
  format: SaveFormat<A, I>,
  stored: unknown,
  maxBytes: number,
): Effect.Effect<A, SaveDecodeError> =>
  readStoredEnvelope(format, stored, maxBytes).pipe(Effect.flatMap((envelope) => decodeSave(format, envelope)))

const isFutureSaveDecodeError = <A, I>(
  format: SaveFormat<A, I>,
  envelope: SaveEnvelope,
  error: SaveDecodeError,
): boolean => envelope.format === format.name && isFromFuture(envelope, format.version) && error.version > format.version

const recoverableCheckpoint = <A, I>(
  format: SaveFormat<A, I>,
  stored: unknown,
  maxBytes: number,
): Effect.Effect<Option.Option<SaveEnvelope>, SaveDecodeError> =>
  Effect.gen(function* () {
    const envelope = yield* readStoredEnvelope(format, stored, maxBytes).pipe(Effect.option)
    if (Option.isNone(envelope)) return Option.none<SaveEnvelope>()

    return yield* decodeSave(format, envelope.value).pipe(
      Effect.as(Option.some(envelope.value)),
      Effect.catchTags({
        SaveDecodeError: (error) =>
          isFutureSaveDecodeError(format, envelope.value, error)
            ? Effect.fail(error)
            : Effect.succeed(Option.none<SaveEnvelope>()),
      }),
    )
  })

export const saveDurably = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  value: A,
  options?: {
    readonly extensions?: Readonly<Record<string, unknown>>
    readonly maxBytes?: number
  },
): Effect.Effect<void, StorageError | SaveDecodeError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const lock = acquireLock(storage, key)
    yield* lock.semaphore.withPermits(1)(
      Effect.gen(function* () {
        const maxBytes = options?.maxBytes ?? DEFAULT_MAX_SAVE_BYTES
        const [latest = Option.none(), previous = Option.none()] = yield* storage.readBatch([
          key,
          durablePreviousKey(key),
        ])
        const latestGood = Option.isSome(latest)
          ? yield* recoverableCheckpoint(format, latest.value, maxBytes)
          : Option.none<SaveEnvelope>()
        const previousGood =
          Option.isNone(latestGood) && Option.isSome(previous)
            ? yield* recoverableCheckpoint(format, previous.value, maxBytes)
            : Option.none<SaveEnvelope>()
        const inherited = Option.isSome(latestGood)
          ? latestGood.value.extensions
          : Option.isSome(previousGood)
            ? previousGood.value.extensions
            : undefined
        const encoded = yield* encodeSave(format, value)
        const sealed = yield* sealAndValidateSaveEnvelope(
          encoded,
          options?.extensions ?? inherited,
          maxBytes,
        )
        const mutations = Option.isSome(latestGood)
          ? [
              {
                _tag: 'Put' as const,
                key: durablePreviousKey(key),
                envelope: latestGood.value,
                expected: previous,
              },
              { _tag: 'Put' as const, key, envelope: sealed, expected: latest },
            ]
          : [{ _tag: 'Put' as const, key, envelope: sealed, expected: latest }]
        yield* storage.commitBatch(mutations)
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => releaseLock(storage, key, lock))))
  })

export const loadDurably = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  maxBytes = DEFAULT_MAX_SAVE_BYTES,
): Effect.Effect<Option.Option<A>, StorageError | SaveDecodeError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const [latest = Option.none(), previous = Option.none()] = yield* storage.readBatch([
      key,
      durablePreviousKey(key),
    ])
    if (Option.isNone(latest)) {
      if (Option.isNone(previous)) return Option.none<A>()
      return Option.some(yield* decodeStored(format, previous.value, maxBytes))
    }
    const latestEnvelope = yield* Effect.either(readStoredEnvelope(format, latest.value, maxBytes))
    if (latestEnvelope._tag === 'Left') {
      return Option.isSome(previous)
        ? yield* decodeStored(format, previous.value, maxBytes).pipe(Effect.map(Option.some))
        : yield* Effect.fail(latestEnvelope.left)
    }

    return yield* decodeSave(format, latestEnvelope.right).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        SaveDecodeError: (latestError) =>
          isFutureSaveDecodeError(format, latestEnvelope.right, latestError)
            ? Effect.fail(latestError)
            : Option.isSome(previous)
              ? decodeStored(format, previous.value, maxBytes).pipe(Effect.map(Option.some))
              : Effect.fail(latestError),
      }),
    )
  })
