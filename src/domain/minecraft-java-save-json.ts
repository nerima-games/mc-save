/* oxlint-disable no-bitwise -- UTF-8 continuation bytes are defined by bit fields. */

import { Data } from 'effect'
import type { MinecraftJsonValue } from './minecraft-java-save-types.js'

export class MinecraftJsonError extends Data.TaggedError('MinecraftJsonError')<{
  readonly operation: 'encode' | 'decode'
  readonly reason: string
}> {
  override get message(): string {
    return `Minecraft JSON ${this.operation} failed: ${this.reason}`
  }
}

const jsonError = (operation: MinecraftJsonError['operation'], reason: string): MinecraftJsonError =>
  new MinecraftJsonError({ operation, reason })

const isJsonNumber = (value: number): boolean => Number.isFinite(value)

const isArrayIndex = (key: string, length: number): boolean => {
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

const isJsonArray = (value: object, seen: WeakSet<object>): value is ReadonlyArray<unknown> => {
  const array = value as ReadonlyArray<unknown>
  const prototype = Object.getPrototypeOf(array)
  if (prototype !== Array.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(array)
  if (!ownKeys.includes('length')) return false
  for (const key of ownKeys) {
    if (key === 'length') {
      const descriptor = Object.getOwnPropertyDescriptor(array, key)
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable) return false
      continue
    }
    if (typeof key !== 'string' || !isArrayIndex(key, array.length)) return false
    const descriptor = Object.getOwnPropertyDescriptor(array, key)
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return false
  }
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(array, String(index))) return false
  }
  for (let index = 0; index < array.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index))
    if (descriptor === undefined || !('value' in descriptor) || !isJsonValueInternal(descriptor.value, seen)) return false
  }
  return true
}

const isJsonObject = (value: object, seen: WeakSet<object>): value is { readonly [key: string]: unknown } => {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return false
    if (!isJsonValueInternal(descriptor.value, seen)) return false
  }
  return true
}

const isJsonValueInternal = (value: unknown, seen: WeakSet<object>): value is MinecraftJsonValue => {
  if (value === null) return true
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true
    case 'number':
      return isJsonNumber(value)
    case 'object':
      break
    default:
      return false
  }

  if (seen.has(value)) return false
  seen.add(value)
  try {
    return Array.isArray(value) ? isJsonArray(value, seen) : isJsonObject(value, seen)
  } finally {
    seen.delete(value)
  }
}

export const isMinecraftJsonValue = (value: unknown): value is MinecraftJsonValue => {
  try {
    return isJsonValueInternal(value, new WeakSet<object>())
  } catch {
    return false
  }
}

const continuation = (value: number): boolean => (value & 0xc0) === 0x80

const decodeUtf8 = (bytes: Uint8Array): string => {
  const codePoints: number[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    const first = bytes[offset]!
    if (first <= 0x7f) {
      codePoints.push(first)
      offset += 1
      continue
    }

    if (first >= 0xc2 && first <= 0xdf) {
      if (offset + 1 >= bytes.byteLength) throw jsonError('decode', 'truncated two-byte UTF-8 sequence')
      const second = bytes[offset + 1]!
      if (!continuation(second)) throw jsonError('decode', 'invalid UTF-8 continuation byte')
      codePoints.push(((first & 0x1f) << 6) | (second & 0x3f))
      offset += 2
      continue
    }

    if (first >= 0xe0 && first <= 0xef) {
      if (offset + 2 >= bytes.byteLength) throw jsonError('decode', 'truncated three-byte UTF-8 sequence')
      const second = bytes[offset + 1]!
      const third = bytes[offset + 2]!
      if (!continuation(second) || !continuation(third)) {
        throw jsonError('decode', 'invalid UTF-8 continuation byte')
      }
      if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second >= 0xa0)) {
        throw jsonError('decode', 'UTF-8 sequence is overlong or encodes a surrogate')
      }
      codePoints.push(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f))
      offset += 3
      continue
    }

    if (first >= 0xf0 && first <= 0xf4) {
      if (offset + 3 >= bytes.byteLength) throw jsonError('decode', 'truncated four-byte UTF-8 sequence')
      const second = bytes[offset + 1]!
      const third = bytes[offset + 2]!
      const fourth = bytes[offset + 3]!
      if (!continuation(second) || !continuation(third) || !continuation(fourth)) {
        throw jsonError('decode', 'invalid UTF-8 continuation byte')
      }
      if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) {
        throw jsonError('decode', 'UTF-8 sequence is outside the Unicode scalar range')
      }
      codePoints.push(
        ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f),
      )
      offset += 4
      continue
    }

    throw jsonError('decode', 'invalid UTF-8 leading byte')
  }
  return String.fromCodePoint(...codePoints)
}

const encodeUtf8 = (value: string): Uint8Array => {
  const bytes: number[] = []
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) throw jsonError('encode', 'string contains an invalid Unicode scalar')
    if (codePoint <= 0x7f) {
      bytes.push(codePoint)
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

export const encodeMinecraftJson = (value: MinecraftJsonValue): Uint8Array => {
  if (!isMinecraftJsonValue(value)) throw jsonError('encode', 'value is not a finite JSON value')
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw jsonError('encode', error instanceof Error ? error.message : String(error))
  }
  if (text === undefined) throw jsonError('encode', 'value cannot be serialized as JSON')
  return encodeUtf8(text)
}

export const decodeMinecraftJson = (bytes: Uint8Array): MinecraftJsonValue => {
  if (!(bytes instanceof Uint8Array)) throw jsonError('decode', 'input must be a Uint8Array')
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(bytes)) as unknown
  } catch (error) {
    if (error instanceof MinecraftJsonError) throw error
    throw jsonError('decode', error instanceof Error ? error.message : String(error))
  }
  if (!isMinecraftJsonValue(parsed)) throw jsonError('decode', 'document is not a finite JSON value')
  return parsed
}
