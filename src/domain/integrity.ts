/* eslint-disable no-bitwise -- UTF-8 encoding and FNV-1a are byte-level algorithms. */
import { Effect } from 'effect'
import type { SaveEnvelope, SaveEnvelopeDraft, SaveIntegrity } from './envelope.js'
import { SaveDecodeError } from './errors.js'
import { canonicalize, checksumOf, utf8Bytes, type Canonicalized } from './integrity-canonical.js'

export { sameSaveEnvelope } from './integrity-canonical.js'

export const DEFAULT_MAX_SAVE_BYTES = 16 * 1024 * 1024

const integrityInput = (envelope: SaveEnvelope | SaveEnvelopeDraft): unknown => ({
  format: envelope.format,
  version: envelope.version,
  payload: envelope.payload,
  ...(envelope.extensions === undefined ? {} : { extensions: envelope.extensions }),
})

const isValidMaxBytes = (maxBytes: number): boolean => Number.isSafeInteger(maxBytes) && maxBytes >= 0

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const isExpectedIntegrity = (value: unknown): value is SaveIntegrity => {
  if (!isRecord(value)) return false
  const record = value
  const byteLength = record['byteLength']
  return (
    record['algorithm'] === 'fnv1a32' &&
    typeof byteLength === 'number' &&
    Number.isSafeInteger(byteLength) &&
    byteLength >= 0 &&
    typeof record['checksum'] === 'string'
  )
}

const invalidMaxBytesError = (
  envelope: Pick<SaveEnvelopeDraft, 'format' | 'version'>,
  maxBytes: number,
): SaveDecodeError =>
  new SaveDecodeError({
    format: envelope.format,
    version: envelope.version,
    reason: `maxBytes must be a non-negative safe integer, received ${String(maxBytes)}`,
  })

export const sealSaveEnvelope = (
  envelope: SaveEnvelope | SaveEnvelopeDraft,
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
  envelope: SaveEnvelope | SaveEnvelopeDraft,
  maxBytes = DEFAULT_MAX_SAVE_BYTES,
): Effect.Effect<SaveEnvelope, SaveDecodeError> => {
  if (!isValidMaxBytes(maxBytes)) return Effect.fail(invalidMaxBytesError(envelope, maxBytes))

  let canonical: Canonicalized
  try {
    canonical = canonicalize(integrityInput(envelope))
  } catch (cause) {
    return Effect.fail(
      new SaveDecodeError({
        format: envelope.format,
        version: envelope.version,
        reason: cause instanceof Error ? cause.message : 'save contains an unsupported value',
        cause,
      }),
    )
  }
  const bytes = utf8Bytes(canonical.text)
  const invalidNumber = canonical.containsInvalidNumber
  const invalidSize = bytes.byteLength > maxBytes
  const integrity = 'integrity' in envelope ? envelope.integrity : undefined

  if (invalidNumber || invalidSize) {
    const reason = invalidNumber ? 'save contains a non-finite number' : `save exceeds the ${String(maxBytes)} byte limit`
    return Effect.fail(new SaveDecodeError({ format: envelope.format, version: envelope.version, reason }))
  }
  if (
    !isExpectedIntegrity(integrity) ||
    integrity.byteLength !== bytes.byteLength ||
    integrity.checksum !== checksumOf(bytes)
  ) {
    return Effect.fail(
      new SaveDecodeError({
        format: envelope.format,
        version: envelope.version,
        reason: 'save checksum or recorded size does not match its contents',
      }),
    )
  }
  return Effect.succeed({ ...envelope, integrity })
}

export const sealAndValidateSaveEnvelope = (
  envelope: SaveEnvelope | SaveEnvelopeDraft,
  extensions: Readonly<Record<string, unknown>> | undefined,
  maxBytes: number,
): Effect.Effect<SaveEnvelope, SaveDecodeError> => {
  if (!isValidMaxBytes(maxBytes)) return Effect.fail(invalidMaxBytesError(envelope, maxBytes))

  const candidate = { ...envelope, ...(extensions === undefined ? {} : { extensions }) }
  let canonical: Canonicalized
  try {
    canonical = canonicalize(integrityInput(candidate))
  } catch (cause) {
    return Effect.fail(
      new SaveDecodeError({
        format: envelope.format,
        version: envelope.version,
        reason: cause instanceof Error ? cause.message : 'save contains an unsupported value',
        cause,
      }),
    )
  }
  const bytes = utf8Bytes(canonical.text)
  if (canonical.containsInvalidNumber || bytes.byteLength > maxBytes) {
    const reason = canonical.containsInvalidNumber
      ? 'save contains a non-finite number'
      : `save exceeds the ${String(maxBytes)} byte limit`
    return Effect.fail(new SaveDecodeError({ format: envelope.format, version: envelope.version, reason }))
  }
  const sealed: SaveEnvelope = {
    ...candidate,
    integrity: {
      algorithm: 'fnv1a32',
      byteLength: bytes.byteLength,
      checksum: checksumOf(bytes),
    },
  }
  return Effect.succeed(sealed)
}
