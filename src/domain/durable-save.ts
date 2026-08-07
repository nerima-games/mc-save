/* eslint-disable no-bitwise -- UTF-8 encoding and FNV-1a are byte-level algorithms. */
import { Effect, Option, Schema } from 'effect'
import { isFromFuture, type SaveEnvelope, SaveEnvelopeSchema, type SaveIntegrity } from './envelope'
import { MigrationError, SaveDecodeError, StorageError } from './errors'
import { decodeSave, encodeSave, type SaveFormat } from './format'
import { SaveKey, StoragePort } from './storage-port'

export const DEFAULT_MAX_SAVE_BYTES = 16 * 1024 * 1024

const utf8Bytes = (value: string): Uint8Array => {
  const bytes: Array<number> = []
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    if (point <= 0x7f) bytes.push(point)
    else if (point <= 0x7ff) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
    else if (point <= 0xffff) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f))
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

type Canonicalized = {
  readonly text: string
  readonly containsInvalidNumber: boolean
}

const canonicalize = (value: unknown): Canonicalized => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { text: JSON.stringify(value), containsInvalidNumber: true }
  }
  if (value === null || typeof value !== 'object') {
    return { text: JSON.stringify(value) ?? 'undefined', containsInvalidNumber: false }
  }
  if (Array.isArray(value)) {
    const values = value.map(canonicalize)
    return {
      text: `[${values.map(({ text }) => text).join(',')}]`,
      containsInvalidNumber: values.some(({ containsInvalidNumber }) => containsInvalidNumber),
    }
  }
  const record = value as Readonly<Record<string, unknown>>
  const values = Object.keys(record)
    .sort()
    .map((key) => ({ key, canonical: canonicalize(record[key]) }))
  return {
    text: `{${values.map(({ key, canonical }) => `${JSON.stringify(key)}:${canonical.text}`).join(',')}}`,
    containsInvalidNumber: values.some(({ canonical }) => canonical.containsInvalidNumber),
  }
}

const checksumOf = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const integrityInput = (envelope: SaveEnvelope): unknown => ({
  format: envelope.format,
  version: envelope.version,
  payload: envelope.payload,
  ...(envelope.extensions === undefined ? {} : { extensions: envelope.extensions }),
})

export const sealSaveEnvelope = (
  envelope: SaveEnvelope,
  extensions?: Readonly<Record<string, unknown>>,
): SaveEnvelope => {
  const candidate = { ...envelope, ...(extensions === undefined ? {} : { extensions }) }
  const bytes = utf8Bytes(canonicalize(integrityInput(candidate)).text)
  const integrity: SaveIntegrity = {
    algorithm: 'fnv1a32',
    byteLength: bytes.byteLength,
    checksum: checksumOf(bytes),
  }
  return { ...candidate, integrity }
}

export const validateSaveEnvelope = (
  envelope: SaveEnvelope,
  maxBytes = DEFAULT_MAX_SAVE_BYTES,
): Effect.Effect<SaveEnvelope, SaveDecodeError> => {
  const canonical = canonicalize(integrityInput(envelope))
  const bytes = utf8Bytes(canonical.text)
  const invalidNumber = canonical.containsInvalidNumber
  const invalidSize = bytes.byteLength > maxBytes
  const invalidChecksum =
    envelope.integrity !== undefined &&
    (envelope.integrity.byteLength !== bytes.byteLength || envelope.integrity.checksum !== checksumOf(bytes))

  if (invalidNumber || invalidSize || invalidChecksum) {
    const reason = invalidNumber
      ? 'save contains a non-finite number'
      : invalidSize
        ? `save exceeds the ${String(maxBytes)} byte limit`
        : 'save checksum or recorded size does not match its contents'
    return Effect.fail(new SaveDecodeError({ format: envelope.format, version: envelope.version, reason }))
  }
  return Effect.succeed(envelope)
}

const sealAndValidateSaveEnvelope = (
  envelope: SaveEnvelope,
  extensions: Readonly<Record<string, unknown>> | undefined,
  maxBytes: number,
): Effect.Effect<SaveEnvelope, SaveDecodeError> => {
  const candidate = { ...envelope, ...(extensions === undefined ? {} : { extensions }) }
  const canonical = canonicalize(integrityInput(candidate))
  const bytes = utf8Bytes(canonical.text)
  if (canonical.containsInvalidNumber || bytes.byteLength > maxBytes) {
    const reason = canonical.containsInvalidNumber
      ? 'save contains a non-finite number'
      : `save exceeds the ${String(maxBytes)} byte limit`
    return Effect.fail(new SaveDecodeError({ format: envelope.format, version: envelope.version, reason }))
  }
  return Effect.succeed({
    ...candidate,
    integrity: {
      algorithm: 'fnv1a32',
      byteLength: bytes.byteLength,
      checksum: checksumOf(bytes),
    },
  })
}

const previousKey = (key: SaveKey): SaveKey => SaveKey(`${key}::previous`)

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
  const locks = saveLocks.get(storage)
  if (locks?.get(key) !== lock) return
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
): Effect.Effect<A, SaveDecodeError | MigrationError> =>
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
        MigrationError: () => Effect.succeed(Option.none<SaveEnvelope>()),
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
          previousKey(key),
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
              { _tag: 'Put' as const, key: previousKey(key), envelope: latestGood.value },
              { _tag: 'Put' as const, key, envelope: sealed },
            ]
          : [{ _tag: 'Put' as const, key, envelope: sealed }]
        yield* storage.commitBatch(mutations)
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => releaseLock(storage, key, lock))))
  })

export const loadDurably = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  maxBytes = DEFAULT_MAX_SAVE_BYTES,
): Effect.Effect<Option.Option<A>, StorageError | SaveDecodeError | MigrationError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const [latest = Option.none(), previous = Option.none()] = yield* storage.readBatch([
      key,
      previousKey(key),
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
        MigrationError: (latestError) =>
          Option.isSome(previous)
            ? decodeStored(format, previous.value, maxBytes).pipe(Effect.map(Option.some))
            : Effect.fail(latestError),
      }),
    )
  })
