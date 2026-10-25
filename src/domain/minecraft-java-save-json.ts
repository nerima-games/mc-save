/* oxlint-disable no-bitwise -- UTF-8 continuation bytes are defined by bit fields. */

import { Data, Result } from 'effect'
import type * as Cause from 'effect/Cause'
import { ValidationMessage } from './brand-types.js'
import { assertDefined } from './assert-defined.js'
import type { MinecraftJsonValue } from './minecraft-java-save-types.js'

type MinecraftJsonErrorFields = {
  readonly operation: 'encode' | 'decode'
  readonly reason: string
}

const MinecraftJsonErrorBase: new (
  args: MinecraftJsonErrorFields,
) => Cause.YieldableError & { readonly _tag: 'MinecraftJsonError' } & Readonly<MinecraftJsonErrorFields> =
  Data.TaggedError('MinecraftJsonError')

export class MinecraftJsonError extends MinecraftJsonErrorBase {
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

const isJsonArray = (array: ReadonlyArray<unknown>, seen: WeakSet<object>): boolean => {
  const prototype = Object.getPrototypeOf(array)
  if (prototype !== Array.prototype && prototype !== null) return false
  // 'length' is not re-checked for presence or enumerability here: Array.isArray (in the caller) guarantees
  // array's ultimate target is a genuine Array exotic object, whose 'length' is always an own, non-enumerable,
  // non-configurable data property -- no real array, and no Proxy wrapping one (per the getOwnPropertyDescriptor
  // trap invariant that a reported descriptor must not make defineProperty on the target throw), can omit it
  // or report it as enumerable.
  const ownKeys = Reflect.ownKeys(array)
  for (const key of ownKeys) {
    if (key === 'length') continue
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
  const result = Result.try({
    try: () => Array.isArray(value) ? isJsonArray(value, seen) : isJsonObject(value, seen),
    catch: () => false,
  })
  seen.delete(value)
  return Result.getOrElse(result, () => false)
}

export const isMinecraftJsonValue = (value: unknown): value is MinecraftJsonValue =>
  isJsonValueInternal(value, new WeakSet<object>())

const continuation = (value: number): boolean => (value & 0xc0) === 0x80

const decodeUtf8 = (bytes: Uint8Array): Result.Result<string, MinecraftJsonError> =>
  Result.gen(function* () {
    const codePoints: number[] = []
    let offset = 0
    while (offset < bytes.byteLength) {
      const first = yield* Result.mapError(assertDefined(bytes[offset], ValidationMessage('decodeUtf8: offset is within byteLength but byte is missing')), (reason) => jsonError('decode', reason))
      if (first <= 0x7f) {
        codePoints.push(first)
        offset += 1
        continue
      }

      if (first >= 0xc2 && first <= 0xdf) {
        if (offset + 1 >= bytes.byteLength) return yield* Result.fail(jsonError('decode', 'truncated two-byte UTF-8 sequence'))
        const second = yield* Result.mapError(assertDefined(bytes[offset + 1], ValidationMessage('decodeUtf8: missing second byte of a two-byte sequence')), (reason) => jsonError('decode', reason))
        if (!continuation(second)) return yield* Result.fail(jsonError('decode', 'invalid UTF-8 continuation byte'))
        codePoints.push(((first & 0x1f) << 6) | (second & 0x3f))
        offset += 2
        continue
      }

      if (first >= 0xe0 && first <= 0xef) {
        if (offset + 2 >= bytes.byteLength) return yield* Result.fail(jsonError('decode', 'truncated three-byte UTF-8 sequence'))
        const second = yield* Result.mapError(assertDefined(bytes[offset + 1], ValidationMessage('decodeUtf8: missing second byte of a three-byte sequence')), (reason) => jsonError('decode', reason))
        const third = yield* Result.mapError(assertDefined(bytes[offset + 2], ValidationMessage('decodeUtf8: missing third byte of a three-byte sequence')), (reason) => jsonError('decode', reason))
        if (!continuation(second) || !continuation(third)) return yield* Result.fail(jsonError('decode', 'invalid UTF-8 continuation byte'))
        if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second >= 0xa0)) {
          return yield* Result.fail(jsonError('decode', 'UTF-8 sequence is overlong or encodes a surrogate'))
        }
        codePoints.push(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f))
        offset += 3
        continue
      }

      if (first >= 0xf0 && first <= 0xf4) {
        if (offset + 3 >= bytes.byteLength) return yield* Result.fail(jsonError('decode', 'truncated four-byte UTF-8 sequence'))
        const second = yield* Result.mapError(assertDefined(bytes[offset + 1], ValidationMessage('decodeUtf8: missing second byte of a four-byte sequence')), (reason) => jsonError('decode', reason))
        const third = yield* Result.mapError(assertDefined(bytes[offset + 2], ValidationMessage('decodeUtf8: missing third byte of a four-byte sequence')), (reason) => jsonError('decode', reason))
        const fourth = yield* Result.mapError(assertDefined(bytes[offset + 3], ValidationMessage('decodeUtf8: missing fourth byte of a four-byte sequence')), (reason) => jsonError('decode', reason))
        if (!continuation(second) || !continuation(third) || !continuation(fourth)) {
          return yield* Result.fail(jsonError('decode', 'invalid UTF-8 continuation byte'))
        }
        if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) {
          return yield* Result.fail(jsonError('decode', 'UTF-8 sequence is outside the Unicode scalar range'))
        }
        codePoints.push(((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f))
        offset += 4
        continue
      }

      return yield* Result.fail(jsonError('decode', 'invalid UTF-8 leading byte'))
    }
    return yield* Result.try({
      try: () => String.fromCodePoint(...codePoints),
      catch: () => jsonError('decode', 'UTF-8 input contains too many code points'),
    })
  })

const encodeUtf8 = (value: string): Result.Result<Uint8Array, MinecraftJsonError> =>
  Result.gen(function* () {
    const bytes: number[] = []
    for (const character of value) {
      const codePoint = character.codePointAt(0)
      if (codePoint === undefined) return yield* Result.fail(jsonError('encode', 'string contains an invalid Unicode scalar'))
      if (codePoint <= 0x7f) {
        bytes.push(codePoint)
      } else if (codePoint <= 0x7ff) {
        bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
      } else if (codePoint <= 0xffff) {
        bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
      } else {
        bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
      }
    }
    return yield* Result.try({
      try: () => Uint8Array.from(bytes),
      catch: () => jsonError('encode', 'UTF-8 output could not be allocated'),
    })
  })

export const encodeMinecraftJson = (value: MinecraftJsonValue): Result.Result<Uint8Array, MinecraftJsonError> =>
  Result.gen(function* () {
    const snapshot = yield* Result.try({
      try: () => structuredClone(value),
      catch: () => jsonError('encode', 'value could not be copied as JSON data'),
    })
    if (!isMinecraftJsonValue(snapshot)) return yield* Result.fail(jsonError('encode', 'value is not a finite JSON value'))
    const text = yield* Result.try({
      try: () => JSON.stringify(snapshot),
      catch: (error) => jsonError('encode', error instanceof Error ? error.message : String(error)),
    })
    if (text === undefined) return yield* Result.fail(jsonError('encode', 'value cannot be serialized as JSON'))
    return yield* encodeUtf8(text)
  })

export const decodeMinecraftJson = (bytes: Uint8Array): Result.Result<MinecraftJsonValue, MinecraftJsonError> =>
  Result.gen(function* () {
    if (!(bytes instanceof Uint8Array)) return yield* Result.fail(jsonError('decode', 'input must be a Uint8Array'))
    const snapshot = yield* Result.try({
      try: () => bytes.slice(),
      catch: () => jsonError('decode', 'input could not be copied'),
    })
    const text = yield* decodeUtf8(snapshot)
    const parsed = yield* Result.try({
      try: () => JSON.parse(text),
      catch: (error) => jsonError('decode', error instanceof Error ? error.message : String(error)),
    })
    if (!isMinecraftJsonValue(parsed)) return yield* Result.fail(jsonError('decode', 'document is not a finite JSON value'))
    return parsed
  })
