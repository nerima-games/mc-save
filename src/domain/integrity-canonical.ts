/* eslint-disable no-bitwise -- UTF-8 encoding and FNV-1a are byte-level algorithms. */
import { Result } from 'effect'
import type { SaveEnvelope } from './envelope.js'

export type Canonicalized = {
  readonly text: string
  readonly containsInvalidNumber: boolean
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

export const utf8Bytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length * 3)
  let offset = 0
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index)
    const second = value.charCodeAt(index + 1)
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
}

const unsupportedValue = (description: string): Result.Result<Canonicalized, string> =>
  Result.fail(`save contains an unsupported value: ${description}`)

const canonicalizeUnsafe = (
  value: unknown,
  ancestors: Set<object>,
): Result.Result<Canonicalized, string> => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Result.succeed({ text: JSON.stringify(value), containsInvalidNumber: true })
  }
  if (value === null) return Result.succeed({ text: 'null', containsInvalidNumber: false })
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return Result.succeed({ text: JSON.stringify(value), containsInvalidNumber: false })
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
    return Result.succeed({
      text: `{${values.map(({ key, canonical }) => `${JSON.stringify(key)}:${canonical.text}`).join(',')}}`,
      containsInvalidNumber: values.some(({ canonical }) => canonical.containsInvalidNumber),
    })
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
    return Result.succeed({
      text: `[${values.map(({ text }) => text).join(',')}]`,
      containsInvalidNumber: values.some(({ containsInvalidNumber }) => containsInvalidNumber),
    })
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
  return Result.succeed({
    text: `{${values.map(({ key, canonical }) => `${JSON.stringify(key)}:${canonical.text}`).join(',')}}`,
    containsInvalidNumber: values.some(({ canonical }) => canonical.containsInvalidNumber),
  })
}

export const canonicalize = (value: unknown): Result.Result<Canonicalized, string> =>
  Result.flatMap(
    Result.try({
      try: () => canonicalizeUnsafe(value, new Set<object>()),
      catch: (cause) =>
        `save contains an unsupported value: ${cause instanceof Error ? cause.message : 'a property could not be read'}`,
    }),
    (result) => result,
  )

export const checksumOf = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const envelopeIdentityInput = (envelope: SaveEnvelope): unknown => ({
  format: envelope.format,
  version: envelope.version,
  payload: envelope.payload,
  integrity: envelope.integrity,
  ...(envelope.extensions === undefined ? {} : { extensions: envelope.extensions }),
})

export const sameSaveEnvelope = (left: SaveEnvelope, right: SaveEnvelope): boolean => {
  const identities = Result.try({
    try: () => [envelopeIdentityInput(left), envelopeIdentityInput(right)] as const,
    catch: () => 'save envelope properties could not be read',
  })
  if (Result.isFailure(identities)) return false

  const leftCanonical = canonicalize(identities.success[0])
  const rightCanonical = canonicalize(identities.success[1])
  return (
    Result.isSuccess(leftCanonical) &&
    Result.isSuccess(rightCanonical) &&
    leftCanonical.success.text === rightCanonical.success.text
  )
}
