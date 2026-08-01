/* eslint-disable no-bitwise -- UTF-8 encoding and FNV-1a are byte-level algorithms. */
import { Effect, Option, Schema } from 'effect'
import { type SaveEnvelope, SaveEnvelopeSchema, type SaveIntegrity } from './envelope'
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

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`
}

const containsInvalidNumber = (value: unknown): boolean => {
  if (typeof value === 'number') return !Number.isFinite(value)
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsInvalidNumber)
  return Object.values(value as Readonly<Record<string, unknown>>).some(containsInvalidNumber)
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
  const bytes = utf8Bytes(canonicalize(integrityInput(candidate)))
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
  const bytes = utf8Bytes(canonicalize(integrityInput(envelope)))
  const invalidNumber = containsInvalidNumber(integrityInput(envelope))
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

const previousKey = (key: SaveKey): SaveKey => SaveKey(`${key}::previous`)

const decodeStored = <A, I>(
  format: SaveFormat<A, I>,
  stored: unknown,
  maxBytes: number,
): Effect.Effect<A, SaveDecodeError | MigrationError> =>
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
    Effect.flatMap((envelope) => decodeSave(format, envelope)),
  )

const validatedStoredEnvelope = <A, I>(
  format: SaveFormat<A, I>,
  stored: unknown,
  maxBytes: number,
): Effect.Effect<SaveEnvelope, SaveDecodeError | MigrationError> =>
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
    Effect.tap((envelope) => decodeSave(format, envelope)),
  )

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
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_SAVE_BYTES
    const [latest = Option.none(), previous = Option.none()] = yield* storage.readBatch([
      key,
      previousKey(key),
    ])
    const latestGood = Option.isSome(latest)
      ? yield* validatedStoredEnvelope(format, latest.value, maxBytes).pipe(Effect.option)
      : Option.none<SaveEnvelope>()
    const previousGood = Option.isSome(previous)
      ? yield* validatedStoredEnvelope(format, previous.value, maxBytes).pipe(Effect.option)
      : Option.none<SaveEnvelope>()
    const inherited = Option.isSome(latestGood)
      ? latestGood.value.extensions
      : Option.isSome(previousGood)
        ? previousGood.value.extensions
        : undefined
    const encoded = yield* encodeSave(format, value)
    const sealed = sealSaveEnvelope(encoded, options?.extensions ?? inherited)
    yield* validateSaveEnvelope(sealed, maxBytes)
    const mutations = Option.isSome(latestGood)
      ? [
          { _tag: 'Put' as const, key: previousKey(key), envelope: latestGood.value },
          { _tag: 'Put' as const, key, envelope: sealed },
        ]
      : [{ _tag: 'Put' as const, key, envelope: sealed }]
    yield* storage.commitBatch(mutations)
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
    if (Option.isNone(latest)) return Option.none<A>()
    return yield* decodeStored(format, latest.value, maxBytes).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        SaveDecodeError: (latestError) =>
          Option.isSome(previous)
            ? decodeStored(format, previous.value, maxBytes).pipe(Effect.map(Option.some))
            : Effect.fail(latestError),
        MigrationError: (latestError) =>
          Option.isSome(previous)
            ? decodeStored(format, previous.value, maxBytes).pipe(Effect.map(Option.some))
            : Effect.fail(latestError),
      }),
    )
  })
