/* eslint-disable no-bitwise -- UTF-8 encoding and FNV-1a are byte-level algorithms. */
import { Result } from 'effect'
import { ByteBuffer, CanonicalJson, CanonicalizationIssue, SaveChecksum, ValidationMessage } from './brand-types.js'
import type { SaveEnvelope } from './envelope.js'

export type Canonicalized = {
  readonly text: CanonicalJson
  readonly containsInvalidNumber: boolean
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null


const makeCanonicalized = (
  text: string,
  containsInvalidNumber: boolean,
): Result.Result<Canonicalized, CanonicalizationIssue> =>
  Result.mapError(
    Result.map(CanonicalJson.result(text), (canonicalText) => ({ text: canonicalText, containsInvalidNumber })),
    () => CanonicalizationIssue('canonical JSON text could not be constructed'),
  )

export const utf8Bytes = (value: CanonicalJson): Result.Result<ByteBuffer, ValidationMessage> => {
  const canonicalValue = Result.mapError(
    CanonicalJson.result(value),
    () => ValidationMessage('canonical JSON must be a string'),
  )
  if (Result.isFailure(canonicalValue)) return Result.fail(canonicalValue.failure)

  const encoded = Result.try({
    try: () => {
      const bytes = new Uint8Array(canonicalValue.success.length * 3)
      let offset = 0
      for (let index = 0; index < canonicalValue.success.length; index += 1) {
        const first = canonicalValue.success.charCodeAt(index)
        const second = canonicalValue.success.charCodeAt(index + 1)
        const point =
          first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
            ? 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
            : first
        if (point <= 0x7f) {
          bytes[offset] = point
          offset += 1
        } else if (point <= 0x7ff) {
          bytes[offset] = 0xc0 | (point >> 6)
          bytes[offset + 1] = 0x80 | (point & 0x3f)
          offset += 2
        } else if (point <= 0xffff) {
          bytes[offset] = 0xe0 | (point >> 12)
          bytes[offset + 1] = 0x80 | ((point >> 6) & 0x3f)
          bytes[offset + 2] = 0x80 | (point & 0x3f)
          offset += 3
        } else {
          bytes[offset] = 0xf0 | (point >> 18)
          bytes[offset + 1] = 0x80 | ((point >> 12) & 0x3f)
          bytes[offset + 2] = 0x80 | ((point >> 6) & 0x3f)
          bytes[offset + 3] = 0x80 | (point & 0x3f)
          offset += 4
          index += 1
        }
      }
      return bytes.subarray(0, offset)
    },
    catch: () => ValidationMessage('canonical JSON could not be encoded as UTF-8'),
  })
  if (Result.isFailure(encoded)) return Result.fail(encoded.failure)

  return Result.mapError(
    ByteBuffer.result(encoded.success),
    () => ValidationMessage('UTF-8 encoder did not produce a byte buffer'),
  )
}

const unsupportedValue = (description: string): Result.Result<Canonicalized, CanonicalizationIssue> =>
  Result.fail(CanonicalizationIssue(`save contains an unsupported value: ${description}`))

const canonicalizeUnsafe = (
  value: unknown,
  ancestors: Set<object>,
): Result.Result<Canonicalized, CanonicalizationIssue> => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return makeCanonicalized(JSON.stringify(value), true)
  }
  if (value === null) return makeCanonicalized('null', false)
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return makeCanonicalized(JSON.stringify(value), false)
  }
  if (!isRecord(value)) return unsupportedValue(typeof value)
  if (ancestors.has(value)) return unsupportedValue('cyclic data')

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)

  if (value instanceof Uint8Array) {
    const values: Array<{ readonly key: string; readonly canonical: Canonicalized }> = []
    for (const key of Object.keys(value).sort()) {
      const child = canonicalizeUnsafe(value[Number(key)], nextAncestors)
      if (Result.isFailure(child)) return child
      values.push({ key, canonical: child.success })
    }
    return makeCanonicalized(
      `{${values.map(({ key, canonical }) => `${JSON.stringify(key)}:${canonical.text}`).join(',')}}`,
      values.some(({ canonical }) => canonical.containsInvalidNumber),
    )
  }

  if (Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      return unsupportedValue('sparse arrays and custom array properties are not supported')
    }
    const values: Array<Canonicalized> = []
    for (let index = 0; index < value.length; index += 1) {
      const child = canonicalizeUnsafe(value[index], nextAncestors)
      if (Result.isFailure(child)) return child
      values.push(child.success)
    }
    return makeCanonicalized(
      `[${values.map(({ text }) => text).join(',')}]`,
      values.some(({ containsInvalidNumber }) => containsInvalidNumber),
    )
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return unsupportedValue('symbol-keyed object properties are not supported')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return unsupportedValue('only plain objects and Uint8Array values are supported')
  }
  const values: Array<{ readonly key: string; readonly canonical: Canonicalized }> = []
  for (const key of Object.keys(value).sort()) {
    const child = canonicalizeUnsafe(value[key], nextAncestors)
    if (Result.isFailure(child)) return child
    values.push({ key, canonical: child.success })
  }
  return makeCanonicalized(
    `{${values.map(({ key, canonical }) => `${JSON.stringify(key)}:${canonical.text}`).join(',')}}`,
    values.some(({ canonical }) => canonical.containsInvalidNumber),
  )
}

export const canonicalize = (value: unknown): Result.Result<Canonicalized, CanonicalizationIssue> =>
  Result.flatMap(
    Result.try({
      try: () => canonicalizeUnsafe(value, new Set<object>()),
      catch: (cause) =>
        CanonicalizationIssue(
          `save contains an unsupported value: ${cause instanceof Error ? cause.message : 'a property could not be read'}`,
        ),
    }),
    (result) => result,
  )

export const checksumOf = (bytes: ByteBuffer): Result.Result<SaveChecksum, ValidationMessage> => {
  const checkedBytes = Result.mapError(
    ByteBuffer.result(bytes),
    () => ValidationMessage('checksum input must be a Uint8Array'),
  )
  if (Result.isFailure(checkedBytes)) return Result.fail(checkedBytes.failure)

  const checksum = Result.try({
    try: () => {
      let hash = 0x811c9dc5
      for (const byte of checkedBytes.success) {
        hash ^= byte
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, '0')
    },
    catch: () => ValidationMessage('checksum bytes could not be read'),
  })
  if (Result.isFailure(checksum)) return Result.fail(checksum.failure)

  return Result.mapError(
    SaveChecksum.result(checksum.success),
    () => ValidationMessage('checksum output must be eight lowercase hexadecimal characters'),
  )
}

const envelopeIdentityInput = (envelope: SaveEnvelope): unknown => ({
  format: envelope.format,
  version: envelope.version,
  payload: envelope.payload,
  integrity: envelope.integrity,
  ...(envelope.extensions === undefined ? {} : { extensions: envelope.extensions }),
})

export const sameSaveEnvelope = (
  left: SaveEnvelope,
  right: SaveEnvelope,
): Result.Result<boolean, CanonicalizationIssue> =>
  Result.flatMap(
    Result.try({
      try: () => [envelopeIdentityInput(left), envelopeIdentityInput(right)] as const,
      catch: () => CanonicalizationIssue('save envelope properties could not be read'),
    }),
    ([leftIdentity, rightIdentity]) =>
      Result.flatMap(canonicalize(leftIdentity), (leftCanonical) =>
        Result.flatMap(canonicalize(rightIdentity), (rightCanonical) => {
          if (leftCanonical.containsInvalidNumber || rightCanonical.containsInvalidNumber) {
            return Result.fail(CanonicalizationIssue('save envelope contains a non-finite number'))
          }
          return Result.succeed(leftCanonical.text === rightCanonical.text)
        }),
      ),
  )
