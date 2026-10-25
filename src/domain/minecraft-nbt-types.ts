import { Brand, Data, Result } from 'effect'
import type * as Cause from 'effect/Cause'
import { encodeModifiedUtf8 } from './minecraft-utf8.js'
import type { JavaModifiedUtf8String } from './minecraft-utf8.js'
import { isMinecraftNbtTag } from './minecraft-nbt-validation.js'

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

export type NbtByteValue = number & Brand.Brand<'NbtByteValue'>
export type NbtShortValue = number & Brand.Brand<'NbtShortValue'>
export type NbtIntValue = number & Brand.Brand<'NbtIntValue'>
export type NbtFloatValue = number & Brand.Brand<'NbtFloatValue'>
export type NbtDoubleValue = number & Brand.Brand<'NbtDoubleValue'>
export type NbtInteger = number & Brand.Brand<'NbtInteger'>
export type NbtTagId = number & Brand.Brand<'NbtTagId'>
export type NbtStringValue = JavaModifiedUtf8String
export type NbtName = JavaModifiedUtf8String

type NbtFormatErrorFields = {
  readonly reason: string
  readonly offset?: number
}

const NbtFormatErrorBase: new (
  args: NbtFormatErrorFields,
) => Cause.YieldableError & { readonly _tag: 'NbtFormatError' } & Readonly<NbtFormatErrorFields> =
  Data.TaggedError('NbtFormatError')

export class NbtFormatError extends NbtFormatErrorBase {
  override get message(): string {
    return this.offset === undefined
      ? `NBT data is invalid: ${this.reason}`
      : `NBT data is invalid at byte offset ${String(this.offset)}: ${this.reason}`
  }
}

export type NbtEnd = { readonly type: 'end' }
export type NbtByte = { readonly type: 'byte'; readonly value: NbtByteValue }
export type NbtShort = { readonly type: 'short'; readonly value: NbtShortValue }
export type NbtInt = { readonly type: 'int'; readonly value: NbtIntValue }
export type NbtLong = { readonly type: 'long'; readonly value: bigint }
export type NbtFloat = { readonly type: 'float'; readonly value: NbtFloatValue }
export type NbtDouble = { readonly type: 'double'; readonly value: NbtDoubleValue }
export type NbtByteArray = { readonly type: 'byteArray'; readonly value: Uint8Array }
export type NbtString = { readonly type: 'string'; readonly value: NbtStringValue }
export type NbtList = {
  readonly type: 'list'
  readonly elementType: NbtTagType
  readonly values: ReadonlyArray<NbtNonEndTag>
}
export type NbtCompound = {
  readonly type: 'compound'
  readonly entries: ReadonlyArray<readonly [name: NbtName, value: NbtNonEndTag]>
}
export type NbtIntArray = { readonly type: 'intArray'; readonly value: ReadonlyArray<NbtIntValue> }
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
  readonly name: NbtName
  readonly root: NbtCompound
}

const nbtError = (reason: string): NbtFormatError => new NbtFormatError({ reason })

const integerInRange = (
  type: NbtTagType,
  value: unknown,
  minimum: number,
  maximum: number,
): Result.Result<number, NbtFormatError> =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? Result.succeed(value)
    : Result.fail(nbtError(`${type} value must be an integer in [${String(minimum)}, ${String(maximum)}]`))

const copyBytes = (value: Uint8Array): Result.Result<Uint8Array, NbtFormatError> => {
  if (!(value instanceof Uint8Array)) return Result.fail(nbtError('byteArray value must be a Uint8Array'))
  return Result.try({
    try: () => value.slice(),
    catch: () => nbtError('byteArray value must be readable'),
  })
}

const snapshotArray = (value: unknown, label: string): Result.Result<ReadonlyArray<unknown>, NbtFormatError> => {
  if (!Array.isArray(value)) return Result.fail(nbtError(`${label} must be an array`))
  return Result.try({
    try: () => {
      const length: number = value.length
      const items: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        items.push(value[index])
      }
      return items
    },
    catch: () => nbtError(`${label} must be a readable array`),
  })
}

const isTagType = (value: unknown): value is NbtTagType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(NBT_TAG_IDS, value)

const assertTagType = (type: unknown): Result.Result<NbtTagType, NbtFormatError> =>
  isTagType(type)
    ? Result.succeed(type)
    : Result.fail(nbtError(`unknown NBT tag type ${String(type)}`))

const assertTag = (
  value: unknown,
  label: string,
): Result.Result<NbtTag, NbtFormatError> => {
  if (value === null || typeof value !== 'object') {
    return Result.fail(nbtError(`${label} must be an NBT tag`))
  }
  return Result.flatMap(
    Result.try({
      try: () => structuredClone(value),
      catch: () => nbtError(`${label} must be an NBT tag`),
    }),
    (snapshot) =>
      isMinecraftNbtTag(snapshot)
        ? Result.succeed(snapshot)
        : Result.fail(nbtError(`${label} must be an NBT tag`)),
  )
}

export const nbtEnd = (): NbtEnd => ({ type: 'end' })

export const nbtByte = (value: unknown): Result.Result<NbtByte, NbtFormatError> =>
  Result.map(
    Result.flatMap(integerInRange('byte', value, -0x80, 0x7f), (checked) =>
      Result.succeed(Brand.nominal<NbtByteValue>()(checked)),
    ),
    (checked) => ({ type: 'byte', value: checked }),
  )

export const nbtShort = (value: unknown): Result.Result<NbtShort, NbtFormatError> =>
  Result.map(
    Result.flatMap(integerInRange('short', value, -0x8000, 0x7fff), (checked) =>
      Result.succeed(Brand.nominal<NbtShortValue>()(checked)),
    ),
    (checked) => ({ type: 'short', value: checked }),
  )

export const nbtInt = (value: unknown): Result.Result<NbtInt, NbtFormatError> =>
  Result.map(
    Result.flatMap(integerInRange('int', value, -0x80000000, 0x7fffffff), (checked) =>
      Result.succeed(Brand.nominal<NbtIntValue>()(checked)),
    ),
    (checked) => ({ type: 'int', value: checked }),
  )

export const nbtLong = (value: bigint): Result.Result<NbtLong, NbtFormatError> => {
  if (typeof value !== 'bigint') return Result.fail(nbtError('long value must be a bigint'))
  if (value < -0x8000000000000000n || value > 0x7fffffffffffffffn) {
    return Result.fail(nbtError('long value is outside the signed 64-bit range'))
  }
  return Result.succeed({ type: 'long', value })
}

export const nbtFloat = (value: unknown): Result.Result<NbtFloat, NbtFormatError> =>
  typeof value === 'number'
    ? Result.succeed({ type: 'float', value: Brand.nominal<NbtFloatValue>()(value) })
    : Result.fail(nbtError('float value must be a number'))

export const nbtDouble = (value: unknown): Result.Result<NbtDouble, NbtFormatError> =>
  typeof value === 'number'
    ? Result.succeed({ type: 'double', value: Brand.nominal<NbtDoubleValue>()(value) })
    : Result.fail(nbtError('double value must be a number'))

export const nbtByteArray = (value: Uint8Array): Result.Result<NbtByteArray, NbtFormatError> =>
  Result.map(copyBytes(value), (copy) => ({ type: 'byteArray', value: copy }))

export const nbtString = (value: unknown): Result.Result<NbtString, NbtFormatError> =>
  Result.gen(function* () {
    if (typeof value !== 'string') {
      return yield* Result.fail(nbtError('string value must be a string'))
    }
    const bytes = yield* Result.mapError(
      encodeModifiedUtf8(value),
      () => nbtError('string value is invalid modified UTF-8'),
    )
    if (bytes.byteLength > 0xffff) {
      return yield* Result.fail(nbtError('string value exceeds the 65535-byte Java modified UTF-8 limit'))
    }
    return {
      type: 'string',
      value: Brand.nominal<NbtStringValue>()(value),
    }
  })

export const nbtList = (
  elementType: NbtTagType,
  values: ReadonlyArray<NbtTag>,
): Result.Result<NbtList, NbtFormatError> =>
  Result.gen(function* () {
    const checkedType = yield* assertTagType(elementType)
    const items = yield* snapshotArray(values, 'list values')
    if (checkedType === 'end' && items.length > 0) {
      return yield* Result.fail(nbtError('an end-typed list must be empty'))
    }
    const copied: Array<NbtNonEndTag> = []
    for (const item of items) {
      const snapshot = yield* assertTag(item, 'list value')
      if (snapshot.type !== checkedType || snapshot.type === 'end') {
        return yield* Result.fail(
          nbtError(`list value type ${snapshot.type} does not match ${checkedType}`),
        )
      }
      copied.push(snapshot)
    }
    return { type: 'list', elementType: checkedType, values: copied }
  })

export const nbtCompound = (
  entries: unknown,
): Result.Result<NbtCompound, NbtFormatError> =>
  Result.gen(function* () {
    const items = yield* snapshotArray(entries, 'compound entries')
    const names = new Set<string>()
    const copied: Array<readonly [name: NbtName, value: NbtNonEndTag]> = []
    for (const item of items) {
      if (!Array.isArray(item)) {
        return yield* Result.fail(nbtError('compound entries must be name-value pairs'))
      }
      const pair = yield* snapshotArray(item, 'compound entry')
      if (pair.length !== 2) {
        return yield* Result.fail(nbtError('compound entries must be name-value pairs'))
      }
      const name = pair[0]
      const value = pair[1]
      if (typeof name !== 'string') {
        return yield* Result.fail(nbtError('compound names must be strings'))
      }
      if (names.has(name)) {
        return yield* Result.fail(nbtError(`compound contains duplicate name ${JSON.stringify(name)}`))
      }
      names.add(name)
      const snapshot = yield* assertTag(value, 'compound value')
      if (snapshot.type === 'end') {
        return yield* Result.fail(nbtError('compound values cannot use the end tag'))
      }
      const nameBytes = yield* Result.mapError(
        encodeModifiedUtf8(name),
        () => nbtError('compound name is invalid modified UTF-8'),
      )
      if (nameBytes.byteLength > 0xffff) {
        return yield* Result.fail(nbtError('compound name exceeds the 65535-byte Java modified UTF-8 limit'))
      }
      copied.push([
        Brand.nominal<NbtName>()(name),
        snapshot,
      ])
    }
    return { type: 'compound', entries: copied }
  })

export const nbtIntArray = (
  value: unknown,
): Result.Result<NbtIntArray, NbtFormatError> =>
  Result.gen(function* () {
    const items = yield* snapshotArray(value, 'intArray value')
    const copied: NbtIntValue[] = []
    for (const entry of items) {
      if (typeof entry !== 'number') {
        return yield* Result.fail(nbtError('intArray value must contain integers'))
      }
      const checked = yield* integerInRange('intArray', entry, -0x80000000, 0x7fffffff)
      copied.push(
        Brand.nominal<NbtIntValue>()(checked),
      )
    }
    return { type: 'intArray', value: copied }
  })

export const nbtLongArray = (
  value: ReadonlyArray<bigint>,
): Result.Result<NbtLongArray, NbtFormatError> =>
  Result.gen(function* () {
    const items = yield* snapshotArray(value, 'longArray value')
    const copied: bigint[] = []
    for (const entry of items) {
      if (typeof entry !== 'bigint') {
        return yield* Result.fail(nbtError('longArray value must contain bigints'))
      }
      copied.push((yield* nbtLong(entry)).value)
    }
    return { type: 'longArray', value: copied }
  })

export const nbtDocument = (name: unknown, root: unknown): Result.Result<NbtDocument, NbtFormatError> =>
  Result.gen(function* () {
    if (typeof name !== 'string') {
      return yield* Result.fail(nbtError('document name must be a string'))
    }
    const snapshot = yield* assertTag(root, 'document root')
    if (snapshot.type !== 'compound') {
      return yield* Result.fail(nbtError('document root must be a compound'))
    }
    const nameBytes = yield* Result.mapError(
      encodeModifiedUtf8(name),
      () => nbtError('document name is invalid modified UTF-8'),
    )
    if (nameBytes.byteLength > 0xffff) {
      return yield* Result.fail(nbtError('document name exceeds the 65535-byte Java modified UTF-8 limit'))
    }
    return {
      name: Brand.nominal<NbtName>()(name),
      root: snapshot,
    }
  })
