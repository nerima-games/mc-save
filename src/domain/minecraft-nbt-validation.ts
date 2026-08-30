import { NBT_TAG_IDS, type NbtDocument, type NbtNonEndTag, type NbtTagType } from './minecraft-nbt-types.js'
import { encodeModifiedUtf8 } from './minecraft-utf8.js'

const MAX_NBT_VALIDATION_DEPTH = 512
const NBT_TAG_TYPES = new Set<string>(Object.keys(NBT_TAG_IDS))

type PlainRecord = Record<string, unknown>

const isPlainRecord = (value: unknown): value is PlainRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const hasExactDataKeys = (value: unknown, keys: readonly string[]): value is PlainRecord => {
  if (!isPlainRecord(value)) return false
  const allowed = new Set(keys)
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length) return false
  return ownKeys.every((key) => {
    if (typeof key !== 'string' || !allowed.has(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
  })
}

const isArrayIndex = (key: string, length: number): boolean => {
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

const isDenseArray = (value: unknown): value is ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Array.prototype && prototype !== null) return false
  // 'length' is not re-checked for presence or enumerability: Array.isArray guarantees value's ultimate
  // target is a genuine Array exotic object, whose 'length' is always an own, non-enumerable,
  // non-configurable data property (see the identical reasoning in minecraft-java-save-json.ts's isJsonArray).
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
}

const isByteArray = (value: unknown): value is Uint8Array => {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) return false
  // No per-index descriptor re-check here: TypedArray's [[DefineOwnProperty]] unconditionally rejects any
  // attempt to redefine a valid in-bounds index with anything other than {writable:true, enumerable:true,
  // configurable:true} (this holds even though getOwnPropertyDescriptor reports configurable:true, since the
  // rejection is a TypedArray-specific override, not the generic non-configurable-property rule) -- so a
  // genuine Uint8Array's indices can never be non-enumerable or missing a 'value'.
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !isArrayIndex(key, value.byteLength)) return false
  }
  return true
}

const isTagType = (value: unknown): value is NbtTagType => typeof value === 'string' && NBT_TAG_TYPES.has(value)

const isModifiedUtf8String = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    return encodeModifiedUtf8(value).byteLength <= 0xffff
  } catch {
    return false
  }
}

const isIntegerInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum

type ValidationContext = { readonly seen: WeakSet<object> }

const isNonEndTag = (value: unknown, context: ValidationContext, depth: number): value is NbtNonEndTag => {
  if (depth > MAX_NBT_VALIDATION_DEPTH || !isPlainRecord(value) || context.seen.has(value)) return false
  context.seen.add(value)
  try {
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
        if (!hasExactDataKeys(value, ['type', 'elementType', 'values']) || !isTagType(value['elementType'])) return false
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
  } finally {
    context.seen.delete(value)
  }
}

export const isMinecraftNbtDocument = (value: unknown): value is NbtDocument => {
  try {
    if (!hasExactDataKeys(value, ['name', 'root']) || !isModifiedUtf8String(value['name'])) return false
    return isNonEndTag(value['root'], { seen: new WeakSet<object>() }, 1) && value['root'].type === 'compound'
  } catch {
    return false
  }
}
