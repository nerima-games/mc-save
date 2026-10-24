/* eslint-disable no-bitwise -- UTF-8 encoding and FNV-1a are byte-level algorithms. */
import { Effect, Result, Schema } from 'effect'
import { SaveEnvelopeDraftSchema, type SaveEnvelope, type SaveEnvelopeDraft, type SaveIntegrity } from './envelope.js'
import { SaveDecodeError } from './errors.js'
import { canonicalize, checksumOf, utf8Bytes } from './integrity-canonical.js'

export { sameSaveEnvelope } from './integrity-canonical.js'

export const DEFAULT_MAX_SAVE_BYTES: number = 16 * 1024 * 1024

type SaveEnvelopeSnapshot = {
  readonly format: unknown
  readonly version: unknown
  readonly payload: unknown
  readonly extensions: Readonly<Record<string, unknown>> | undefined
  readonly integrity: SaveIntegrity | undefined
}

const saveDecodeError = (format: unknown, version: unknown, reason: string, cause?: unknown): SaveDecodeError =>
  new SaveDecodeError({
    format: typeof format === 'string' ? format : 'unknown',
    version: typeof version === 'number' && Number.isSafeInteger(version) ? version : 0,
    reason,
    ...(cause === undefined ? {} : { cause }),
  })

const snapshotExtensions = (
  format: unknown,
  version: unknown,
  value: unknown,
): Result.Result<Readonly<Record<string, unknown>> | undefined, SaveDecodeError> => {
  if (value === undefined) return Result.succeed(undefined)
  const captured = Result.try({
    try: () => {
      if (!isRecord(value) || Array.isArray(value)) return undefined
      return {
        prototype: Object.getPrototypeOf(value),
        symbols: Object.getOwnPropertySymbols(value),
        entries: Object.keys(value).map((key) => [key, value[key]] as const),
      }
    },
    catch: (cause) => saveDecodeError(format, version, 'save envelope extensions could not be read', cause),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const snapshot = captured.success
  if (
    snapshot === undefined ||
    (snapshot.prototype !== Object.prototype && snapshot.prototype !== null) ||
    snapshot.symbols.length > 0
  ) {
    return Result.fail(saveDecodeError(format, version, 'save envelope extensions must be a plain string-keyed object'))
  }
  return Result.succeed(Object.fromEntries(snapshot.entries))
}

const snapshotIntegrity = (
  format: unknown,
  version: unknown,
  value: unknown,
): Result.Result<SaveIntegrity | undefined, SaveDecodeError> => {
  if (value === undefined) return Result.succeed(undefined)
  const captured = Result.try({
    try: () => {
      if (!isRecord(value) || Array.isArray(value)) return undefined
      return {
        algorithm: value['algorithm'],
        byteLength: value['byteLength'],
        checksum: value['checksum'],
      }
    },
    catch: (cause) => saveDecodeError(format, version, 'save integrity fields could not be read', cause),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const fields = captured.success
  if (
    fields === undefined ||
    fields.algorithm !== 'fnv1a32' ||
    typeof fields.byteLength !== 'number' ||
    !Number.isSafeInteger(fields.byteLength) ||
    fields.byteLength < 0 ||
    typeof fields.checksum !== 'string' ||
    !/^[0-9a-f]{8}$/u.test(fields.checksum)
  ) {
    return Result.fail(saveDecodeError(format, version, 'save integrity metadata is malformed'))
  }
  return Result.succeed({
    algorithm: 'fnv1a32',
    byteLength: fields.byteLength,
    checksum: fields.checksum,
  })
}

const decodeDraft = (
  draft: unknown,
  format: unknown,
  version: unknown,
): Result.Result<SaveEnvelopeDraft, SaveDecodeError> => {
  const decoded = Schema.decodeUnknownResult(SaveEnvelopeDraftSchema)(draft)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      saveDecodeError(format, version, 'save envelope draft is malformed', decoded.failure),
    )
  }
  return Result.succeed(decoded.success)
}

const snapshotEnvelope = (
  envelope: unknown,
): Result.Result<SaveEnvelopeSnapshot, SaveDecodeError> => {
  const captured = Result.try({
    try: () => {
      if (!isRecord(envelope)) return undefined
      return {
        format: envelope['format'],
        version: envelope['version'],
        payload: envelope['payload'],
        extensions: envelope['extensions'],
        integrity: envelope['integrity'],
      }
    },
    catch: (cause) => saveDecodeError('unknown', 0, 'save envelope fields could not be read', cause),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const source = captured.success
  if (source === undefined) {
    return Result.fail(saveDecodeError('unknown', 0, 'save envelope must be an object'))
  }
  const extensions = snapshotExtensions(source.format, source.version, source.extensions)
  if (Result.isFailure(extensions)) return Result.fail(extensions.failure)
  const integrity = snapshotIntegrity(source.format, source.version, source.integrity)
  if (Result.isFailure(integrity)) return Result.fail(integrity.failure)
  return Result.succeed({
    format: source.format,
    version: source.version,
    payload: source.payload,
    extensions: extensions.success,
    integrity: integrity.success,
  })
}

const integrityInput = (envelope: SaveEnvelope | SaveEnvelopeDraft): unknown => ({
  format: envelope.format,
  version: envelope.version,
  payload: envelope.payload,
  ...(envelope.extensions === undefined ? {} : { extensions: envelope.extensions }),
})

const isValidMaxBytes = (maxBytes: number): boolean => Number.isSafeInteger(maxBytes) && maxBytes >= 0

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const invalidMaxBytesError = (format: unknown, version: unknown, maxBytes: number): SaveDecodeError =>
  saveDecodeError(format, version, `maxBytes must be a non-negative safe integer, received ${String(maxBytes)}`)

export const sealSaveEnvelope = (
  envelope: SaveEnvelope | SaveEnvelopeDraft,
  extensions?: Readonly<Record<string, unknown>>,
): Result.Result<SaveEnvelope, SaveDecodeError> => {
  const snapshot = snapshotEnvelope(envelope)
  if (Result.isFailure(snapshot)) return Result.fail(snapshot.failure)
  const source = snapshot.success
  const extensionInput = extensions === undefined ? source.extensions : extensions
  const extensionSnapshot = snapshotExtensions(source.format, source.version, extensionInput)
  if (Result.isFailure(extensionSnapshot)) return Result.fail(extensionSnapshot.failure)
  const candidate = {
    format: source.format,
    version: source.version,
    payload: source.payload,
    ...(extensionSnapshot.success === undefined ? {} : { extensions: extensionSnapshot.success }),
  }
  const decodedDraft = decodeDraft(candidate, source.format, source.version)
  if (Result.isFailure(decodedDraft)) return Result.fail(decodedDraft.failure)
  const canonical = canonicalize(integrityInput(decodedDraft.success))
  if (Result.isFailure(canonical)) {
    return Result.fail(saveDecodeError(source.format, source.version, canonical.failure, canonical.failure))
  }
  if (canonical.success.containsInvalidNumber) {
    return Result.fail(saveDecodeError(source.format, source.version, 'save contains a non-finite number'))
  }
  const bytes = utf8Bytes(canonical.success.text)
  const integrity: SaveIntegrity = {
    algorithm: 'fnv1a32',
    byteLength: bytes.byteLength,
    checksum: checksumOf(bytes),
  }
  if (
    source.integrity !== undefined &&
    (source.integrity.byteLength !== integrity.byteLength || source.integrity.checksum !== integrity.checksum)
  ) {
    return Result.fail(
      saveDecodeError(source.format, source.version, 'save checksum or recorded size does not match its contents'),
    )
  }
  return Result.succeed({ ...decodedDraft.success, integrity })
}

export const validateSaveEnvelope = (
  envelope: SaveEnvelope | SaveEnvelopeDraft,
  maxBytes: number = DEFAULT_MAX_SAVE_BYTES,
): Effect.Effect<SaveEnvelope, SaveDecodeError> => {
  const snapshot = snapshotEnvelope(envelope)
  if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
  const source = snapshot.success
  if (!isValidMaxBytes(maxBytes)) return Effect.fail(invalidMaxBytesError(source.format, source.version, maxBytes))
  const candidate = {
    format: source.format,
    version: source.version,
    payload: source.payload,
    ...(source.extensions === undefined ? {} : { extensions: source.extensions }),
  }
  const decodedDraft = decodeDraft(candidate, source.format, source.version)
  if (Result.isFailure(decodedDraft)) return Effect.fail(decodedDraft.failure)
  const canonical = canonicalize(integrityInput(decodedDraft.success))
  if (Result.isFailure(canonical)) {
    return Effect.fail(saveDecodeError(source.format, source.version, canonical.failure, canonical.failure))
  }
  const bytes = utf8Bytes(canonical.success.text)
  const invalidNumber = canonical.success.containsInvalidNumber
  const invalidSize = bytes.byteLength > maxBytes
  if (invalidNumber || invalidSize) {
    const reason = invalidNumber
      ? 'save contains a non-finite number'
      : `save exceeds the ${String(maxBytes)} byte limit`
    return Effect.fail(saveDecodeError(source.format, source.version, reason))
  }
  const integrity = source.integrity
  if (
    integrity === undefined ||
    integrity.byteLength !== bytes.byteLength ||
    integrity.checksum !== checksumOf(bytes)
  ) {
    return Effect.fail(
      saveDecodeError(source.format, source.version, 'save checksum or recorded size does not match its contents'),
    )
  }
  return Effect.succeed({ ...decodedDraft.success, integrity })
}

export const sealAndValidateSaveEnvelope = (
  envelope: SaveEnvelope | SaveEnvelopeDraft,
  extensions: Readonly<Record<string, unknown>> | undefined,
  maxBytes: number,
): Effect.Effect<SaveEnvelope, SaveDecodeError> =>
  Effect.fromResult(sealSaveEnvelope(envelope, extensions)).pipe(
    Effect.flatMap((sealed) => validateSaveEnvelope(sealed, maxBytes)),
  )
