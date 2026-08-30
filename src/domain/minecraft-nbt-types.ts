import { Data } from 'effect'
import { encodeModifiedUtf8 } from './minecraft-utf8.js'

export const NBT_TAG_IDS = {
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12,
} as const

export type NbtTagType = keyof typeof NBT_TAG_IDS

export class NbtFormatError extends Data.TaggedError('NbtFormatError')<{
  readonly reason: string
  readonly offset?: number
}> {
  override get message(): string {
    return this.offset === undefined
      ? `NBT data is invalid: ${this.reason}`
      : `NBT data is invalid at byte offset ${String(this.offset)}: ${this.reason}`
  }
}

export type NbtEnd = { readonly type: 'end' }
export type NbtByte = { readonly type: 'byte'; readonly value: number }
export type NbtShort = { readonly type: 'short'; readonly value: number }
export type NbtInt = { readonly type: 'int'; readonly value: number }
export type NbtLong = { readonly type: 'long'; readonly value: bigint }
export type NbtFloat = { readonly type: 'float'; readonly value: number }
export type NbtDouble = { readonly type: 'double'; readonly value: number }
export type NbtByteArray = { readonly type: 'byteArray'; readonly value: Uint8Array }
export type NbtString = { readonly type: 'string'; readonly value: string }
export type NbtList = {
  readonly type: 'list'
  readonly elementType: NbtTagType
  readonly values: ReadonlyArray<NbtNonEndTag>
}
export type NbtCompound = {
  readonly type: 'compound'
  readonly entries: ReadonlyArray<readonly [name: string, value: NbtNonEndTag]>
}
export type NbtIntArray = { readonly type: 'intArray'; readonly value: ReadonlyArray<number> }
export type NbtLongArray = { readonly type: 'longArray'; readonly value: ReadonlyArray<bigint> }

export type NbtTag =
  | NbtEnd
  | NbtByte
  | NbtShort
  | NbtInt
  | NbtLong
  | NbtFloat
  | NbtDouble
  | NbtByteArray
  | NbtString
  | NbtList
  | NbtCompound
  | NbtIntArray
  | NbtLongArray

export type NbtNonEndTag = Exclude<NbtTag, NbtEnd>

export type NbtDocument = {
  readonly name: string
  readonly root: NbtCompound
}

const nbtError = (reason: string): NbtFormatError => new NbtFormatError({ reason })

const integerInRange = (type: NbtTagType, value: number, minimum: number, maximum: number): number => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw nbtError(`${type} value must be an integer in [${String(minimum)}, ${String(maximum)}]`)
  }
  return value
}

const copyBytes = (value: Uint8Array): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw nbtError('byteArray value must be a Uint8Array')
  return value.slice()
}

const isTagType = (value: unknown): value is NbtTagType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(NBT_TAG_IDS, value)

const assertTagType: (type: unknown) => asserts type is NbtTagType = (type: unknown): void => {
  if (!isTagType(type)) throw nbtError(`unknown NBT tag type ${String(type)}`)
}

const assertTag: (value: unknown, label: string) => asserts value is NbtTag = (
  value: unknown,
  label: string,
): void => {
  if (value === null || typeof value !== 'object' || !('type' in value) || !isTagType(value.type)) {
    throw nbtError(`${label} must be an NBT tag`)
  }
}

export const nbtEnd = (): NbtEnd => ({ type: 'end' })

export const nbtByte = (value: number): NbtByte => ({
  type: 'byte',
  value: integerInRange('byte', value, -0x80, 0x7f),
})

export const nbtShort = (value: number): NbtShort => ({
  type: 'short',
  value: integerInRange('short', value, -0x8000, 0x7fff),
})

export const nbtInt = (value: number): NbtInt => ({
  type: 'int',
  value: integerInRange('int', value, -0x80000000, 0x7fffffff),
})

export const nbtLong = (value: bigint): NbtLong => {
  if (typeof value !== 'bigint') throw nbtError('long value must be a bigint')
  if (value < -0x8000000000000000n || value > 0x7fffffffffffffffn) {
    throw nbtError('long value is outside the signed 64-bit range')
  }
  return { type: 'long', value }
}

export const nbtFloat = (value: number): NbtFloat => {
  if (typeof value !== 'number') throw nbtError('float value must be a number')
  return { type: 'float', value }
}

export const nbtDouble = (value: number): NbtDouble => {
  if (typeof value !== 'number') throw nbtError('double value must be a number')
  return { type: 'double', value }
}

export const nbtByteArray = (value: Uint8Array): NbtByteArray => ({ type: 'byteArray', value: copyBytes(value) })

export const nbtString = (value: string): NbtString => {
  if (typeof value !== 'string') throw nbtError('string value must be a string')
  if (encodeModifiedUtf8(value).byteLength > 0xffff) {
    throw nbtError('string value exceeds the 65535-byte Java modified UTF-8 limit')
  }
  return { type: 'string', value }
}

export const nbtList = (
  elementType: NbtTagType,
  values: ReadonlyArray<NbtTag>,
): NbtList => {
  assertTagType(elementType)
  if (!Array.isArray(values)) throw nbtError('list values must be an array')
  if (elementType === 'end' && values.length > 0) throw nbtError('an end-typed list must be empty')
  const copied: Array<NbtNonEndTag> = []
  for (const value of values) {
    assertTag(value, 'list value')
    if (value.type !== elementType || value.type === 'end') {
      throw nbtError(`list value type ${value.type} does not match ${elementType}`)
    }
    copied.push(value)
  }
  return { type: 'list', elementType, values: copied }
}

export const nbtCompound = (
  entries: ReadonlyArray<readonly [name: string, value: NbtTag]>,
): NbtCompound => {
  if (!Array.isArray(entries)) throw nbtError('compound entries must be an array')
  const names = new Set<string>()
  const copied: Array<readonly [name: string, value: NbtNonEndTag]> = []
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw nbtError('compound entries must be name-value pairs')
    const [name, value] = entry
    if (typeof name !== 'string') throw nbtError('compound names must be strings')
    if (names.has(name)) throw nbtError(`compound contains duplicate name ${JSON.stringify(name)}`)
    names.add(name)
    assertTag(value, 'compound value')
    if (value.type === 'end') throw nbtError('compound values cannot use the end tag')
    if (encodeModifiedUtf8(name).byteLength > 0xffff) {
      throw nbtError('compound name exceeds the 65535-byte Java modified UTF-8 limit')
    }
    copied.push([name, value])
  }
  return { type: 'compound', entries: copied }
}

export const nbtIntArray = (value: ReadonlyArray<number>): NbtIntArray => {
  if (!Array.isArray(value)) throw nbtError('intArray value must be an array')
  return {
    type: 'intArray',
    value: value.map((entry) => integerInRange('intArray', entry, -0x80000000, 0x7fffffff)),
  }
}

export const nbtLongArray = (value: ReadonlyArray<bigint>): NbtLongArray => {
  if (!Array.isArray(value)) throw nbtError('longArray value must be an array')
  return {
    type: 'longArray',
    value: value.map((entry) => nbtLong(entry).value),
  }
}

export const nbtDocument = (name: string, root: NbtCompound): NbtDocument => {
  if (typeof name !== 'string') throw nbtError('document name must be a string')
  if (root === null || typeof root !== 'object' || root.type !== 'compound') {
    throw nbtError('document root must be a compound')
  }
  if (encodeModifiedUtf8(name).byteLength > 0xffff) {
    throw nbtError('document name exceeds the 65535-byte Java modified UTF-8 limit')
  }
  return { name, root }
}
