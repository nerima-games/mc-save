/* eslint-disable no-bitwise -- UTF-8 encoding and FNV-1a are byte-level algorithms. */
import { assertDefined } from './assert-defined.js'
import type { SaveEnvelope } from './envelope.js'

export type Canonicalized = {
  readonly text: string
  readonly containsInvalidNumber: boolean
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

export const utf8Bytes = (value: string): Uint8Array => {
  let ascii = true
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      ascii = false
      break
    }
  }
  if (ascii) {
    const bytes = new Uint8Array(value.length)
    for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index)
    return bytes
  }

  const bytes = new Uint8Array(value.length * 3)
  let offset = 0
  for (let index = 0; index < value.length; index += 1) {
    const point = assertDefined(value.codePointAt(index), `utf8Bytes: no code point at index ${String(index)}`)
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

const unsupportedValue = (description: string): never => {
  throw new TypeError(`save contains an unsupported value: ${description}`)
}

export const canonicalize = (value: unknown, ancestors = new Set<object>()): Canonicalized => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { text: JSON.stringify(value), containsInvalidNumber: true }
  }
  if (value === null) {
    return { text: 'null', containsInvalidNumber: false }
  }
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return { text: JSON.stringify(value), containsInvalidNumber: false }
  }
  if (!isRecord(value)) {
    return unsupportedValue(typeof value)
  }
  if (ancestors.has(value)) {
    return unsupportedValue('cyclic data')
  }
  ancestors.add(value)

  try {
    if (value instanceof Uint8Array) {
      const values = Object.keys(value)
        .sort()
        .map((key) => ({ key, canonical: canonicalize(value[Number(key)], ancestors) }))
      return {
        text: `{${values.map(({ key, canonical }) => `${JSON.stringify(key)}:${canonical.text}`).join(',')}}`,
        containsInvalidNumber: values.some(({ canonical }) => canonical.containsInvalidNumber),
      }
    }
    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        return unsupportedValue('sparse arrays and custom array properties are not supported')
      }
      const values = value.map((item) => canonicalize(item, ancestors))
      return {
        text: `[${values.map(({ text }) => text).join(',')}]`,
        containsInvalidNumber: values.some(({ containsInvalidNumber }) => containsInvalidNumber),
      }
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      return unsupportedValue('symbol-keyed object properties are not supported')
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupportedValue('only plain objects and Uint8Array values are supported')
    }
    const values = Object.keys(value)
      .sort()
      .map((key) => ({ key, canonical: canonicalize(value[key], ancestors) }))
    return {
      text: `{${values.map(({ key, canonical }) => `${JSON.stringify(key)}:${canonical.text}`).join(',')}}`,
      containsInvalidNumber: values.some(({ canonical }) => canonical.containsInvalidNumber),
    }
  } finally {
    ancestors.delete(value)
  }
}

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

const sameCanonicalValue = (
  left: unknown,
  right: unknown,
  leftAncestors = new Set<object>(),
  rightAncestors = new Set<object>(),
): boolean => {
  const leftType = typeof left
  const rightType = typeof right
  if (leftType === 'number' && !Number.isFinite(left)) {
    return right === null || (rightType === 'number' && !Number.isFinite(right))
  }
  if (rightType === 'number' && !Number.isFinite(right)) return left === null
  if (left === null || right === null) return left === right
  if (leftType !== rightType) return false
  if (leftType === 'string' || leftType === 'boolean' || leftType === 'number') return left === right
  if (!isRecord(left) || !isRecord(right)) return false

  const leftObject = left
  const rightObject = right
  if (leftAncestors.has(leftObject) || rightAncestors.has(rightObject)) return false
  leftAncestors.add(leftObject)
  rightAncestors.add(rightObject)

  try {
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) return false
      const leftValues: ReadonlyArray<unknown> = left
      const rightValues: ReadonlyArray<unknown> = right
      const leftKeys = Object.keys(leftValues)
      const rightKeys = Object.keys(rightValues)
      if (
        leftKeys.length !== leftValues.length ||
        rightKeys.length !== rightValues.length ||
        leftKeys.some((key, index) => key !== String(index)) ||
        rightKeys.some((key, index) => key !== String(index)) ||
        leftValues.length !== rightValues.length
      ) {
        return false
      }
      for (let index = 0; index < leftValues.length; index += 1) {
        if (!sameCanonicalValue(leftValues[index], rightValues[index], leftAncestors, rightAncestors)) return false
      }
      return true
    }

    const leftBinary = left instanceof Uint8Array
    const rightBinary = right instanceof Uint8Array
    if (!leftBinary && Object.getOwnPropertySymbols(left).length > 0) return false
    if (!rightBinary && Object.getOwnPropertySymbols(right).length > 0) return false
    if (!leftBinary) {
      const prototype = Object.getPrototypeOf(left)
      if (prototype !== Object.prototype && prototype !== null) return false
    }
    if (!rightBinary) {
      const prototype = Object.getPrototypeOf(right)
      if (prototype !== Object.prototype && prototype !== null) return false
    }

    const leftKeys = Object.keys(leftObject).sort()
    const rightKeys = Object.keys(rightObject).sort()
    if (leftKeys.length !== rightKeys.length) return false
    for (let index = 0; index < leftKeys.length; index += 1) {
      const leftKey = leftKeys[index]
      const rightKey = rightKeys[index]
      if (leftKey === undefined || rightKey === undefined || leftKey !== rightKey) return false
      const leftValue = left instanceof Uint8Array ? left[Number(leftKey)] : left[leftKey]
      const rightValue = right instanceof Uint8Array ? right[Number(rightKey)] : right[rightKey]
      if (!sameCanonicalValue(leftValue, rightValue, leftAncestors, rightAncestors)) return false
    }
    return true
  } finally {
    leftAncestors.delete(leftObject)
    rightAncestors.delete(rightObject)
  }
}

export const sameSaveEnvelope = (left: SaveEnvelope, right: SaveEnvelope): boolean => {
  try {
    return sameCanonicalValue(envelopeIdentityInput(left), envelopeIdentityInput(right))
  } catch {
    return false
  }
}
