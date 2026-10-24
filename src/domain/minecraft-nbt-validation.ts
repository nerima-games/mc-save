import type { NbtDocument, NbtNonEndTag, NbtTag, NbtTagType } from './minecraft-nbt-types.js'
import { encodeModifiedUtf8 } from './minecraft-utf8.js'

const MAX_NBT_VALIDATION_DEPTH = 512
import { Result } from 'effect'
const NBT_TAG_TYPES = new Set<string>(['end', 'byte', 'short', 'int', 'long', 'float', 'double', 'byteArray', 'string', 'list', 'compound', 'intArray', 'longArray'])

type PlainRecord = Record<string, unknown>

const isPlainRecord = (value: unknown): value is PlainRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    return false
  }
  return Result.getOrElse(
    Result.try({
      try: () => {
        const prototype = Object.getPrototypeOf(value)
        return prototype === Object.prototype || prototype === null
      },
      catch: () => false,
    }),
    () => false,
  )
}

const hasExactDataKeys = (value: unknown, keys: readonly string[]): value is PlainRecord => {
  if (!isPlainRecord(value)) return false
  return Result.getOrElse(
    Result.try({
      try: () => {
        const allowed = new Set(keys)
        const ownKeys = Reflect.ownKeys(value)
        if (ownKeys.length !== keys.length) return false
        return ownKeys.every((key) => {
          if (typeof key !== 'string' || !allowed.has(key)) return false
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
        })
      },
      catch: () => false,
    }),
    () => false,
  )
}

const isArrayIndex = (key: string, length: number): boolean => {
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

const isDenseArray = (value: unknown): value is ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) return false
  return Result.getOrElse(
    Result.try({
      try: () => {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Array.prototype && prototype !== null) return false
        const ownKeys = Reflect.ownKeys(value)
        for (const key of ownKeys) {
          if (key === 'length') continue
          if (typeof key !== 'string' || !isArrayIndex(key, value.length)) return false
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return false
        }
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(value, String(index))) return false
        }
        return true
      },
      catch: () => false,
    }),
    () => false,
  )
}

const isByteArray = (value: unknown): value is Uint8Array => {
  if (!(value instanceof Uint8Array)) return false
  return Result.getOrElse(
    Result.try({
      try: () => {
        if (Object.getPrototypeOf(value) !== Uint8Array.prototype) return false
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== 'string' || !isArrayIndex(key, value.byteLength)) return false
        }
        return true
      },
      catch: () => false,
    }),
    () => false,
  )
}

const isTagType = (value: unknown): value is NbtTagType => typeof value === 'string' && NBT_TAG_TYPES.has(value)

const isModifiedUtf8String = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const encoded = encodeModifiedUtf8(value)
  return Result.isSuccess(encoded) && encoded.success.byteLength <= 0xffff
}

const isIntegerInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum

type ValidationContext = { readonly seen: WeakSet<object> }

const isNonEndTag = (value: unknown, context: ValidationContext, depth: number): value is NbtNonEndTag => {
  if (depth > MAX_NBT_VALIDATION_DEPTH || !isPlainRecord(value) || context.seen.has(value)) return false
  context.seen.add(value)
  const result = Result.try({
    try: () => {
      const type = value['type']
      switch (type) {
        case 'byte':
          return hasExactDataKeys(value, ['type', 'value']) && isIntegerInRange(value['value'], -0x80, 0x7f)
        case 'short':
          return hasExactDataKeys(value, ['type', 'value']) && isIntegerInRange(value['value'], -0x8000, 0x7fff)
        case 'int':
          return hasExactDataKeys(value, ['type', 'value']) && isIntegerInRange(value['value'], -0x80000000, 0x7fffffff)
        case 'long':
          return (
            hasExactDataKeys(value, ['type', 'value']) &&
            typeof value['value'] === 'bigint' &&
            value['value'] >= -0x8000000000000000n &&
            value['value'] <= 0x7fffffffffffffffn
          )
        case 'float':
        case 'double':
          return hasExactDataKeys(value, ['type', 'value']) && typeof value['value'] === 'number'
        case 'byteArray':
          return hasExactDataKeys(value, ['type', 'value']) && isByteArray(value['value'])
        case 'string':
          return hasExactDataKeys(value, ['type', 'value']) && isModifiedUtf8String(value['value'])
        case 'list': {
          if (!hasExactDataKeys(value, ['type', 'elementType', 'values']) || !isTagType(value['elementType'])) {
            return false
          }
          if (!isDenseArray(value['values'])) return false
          if (value['elementType'] === 'end') return value['values'].length === 0
          for (const entry of value['values']) {
            if (!isNonEndTag(entry, context, depth + 1) || entry.type !== value['elementType']) return false
          }
          return true
        }
        case 'compound': {
          if (!hasExactDataKeys(value, ['type', 'entries']) || !isDenseArray(value['entries'])) return false
          const names = new Set<string>()
          for (const entry of value['entries']) {
            if (!isDenseArray(entry) || entry.length !== 2) return false
            const name = entry[0]
            if (!isModifiedUtf8String(name) || names.has(name)) return false
            names.add(name)
            if (!isNonEndTag(entry[1], context, depth + 1)) return false
          }
          return true
        }
        case 'intArray':
          return (
            hasExactDataKeys(value, ['type', 'value']) &&
            isDenseArray(value['value']) &&
            value['value'].every((entry) => isIntegerInRange(entry, -0x80000000, 0x7fffffff))
          )
        case 'longArray':
          return (
            hasExactDataKeys(value, ['type', 'value']) &&
            isDenseArray(value['value']) &&
            value['value'].every(
              (entry) =>
                typeof entry === 'bigint' &&
                entry >= -0x8000000000000000n &&
                entry <= 0x7fffffffffffffffn,
            )
          )
        default:
          return false
      }
    },
    catch: () => false,
  })
  context.seen.delete(value)
  return Result.getOrElse(result, () => false)
}


export const isMinecraftNbtTag = (value: unknown): value is NbtTag => {
  const result = Result.try({
    try: () => {
      if (!isPlainRecord(value)) return false
      if (value['type'] === 'end') return hasExactDataKeys(value, ['type'])
      return isNonEndTag(value, { seen: new WeakSet<object>() }, 1)
    },
    catch: () => false,
  })
  return Result.getOrElse(result, () => false)
}

export const isMinecraftNbtDocument = (value: unknown): value is NbtDocument => {
  const result = Result.try({
    try: () => {
      if (!hasExactDataKeys(value, ['name', 'root']) || !isModifiedUtf8String(value['name'])) return false
      const root = value['root']
      return isNonEndTag(root, { seen: new WeakSet<object>() }, 1) && root.type === 'compound'
    },
    catch: () => false,
  })
  return Result.getOrElse(result, () => false)
}
