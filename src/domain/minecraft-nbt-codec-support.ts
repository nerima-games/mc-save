import { Brand, Option, Result } from 'effect'
import { NBT_TAG_IDS } from './minecraft-nbt-types.js'
import type { NbtFormatError, NbtInteger, NbtTagId, NbtTagType } from './minecraft-nbt-types.js'
import { nbtError } from './minecraft-nbt-codec-options.js'

export type NbtPayloadTagType = Exclude<NbtTagType, 'end'>

export const tagTypeFromId = (id: unknown): Option.Option<NbtTagType> => {
  switch (id) {
    case NBT_TAG_IDS.end:
      return Option.some('end')
    case NBT_TAG_IDS.byte:
      return Option.some('byte')
    case NBT_TAG_IDS.short:
      return Option.some('short')
    case NBT_TAG_IDS.int:
      return Option.some('int')
    case NBT_TAG_IDS.long:
      return Option.some('long')
    case NBT_TAG_IDS.float:
      return Option.some('float')
    case NBT_TAG_IDS.double:
      return Option.some('double')
    case NBT_TAG_IDS.byteArray:
      return Option.some('byteArray')
    case NBT_TAG_IDS.string:
      return Option.some('string')
    case NBT_TAG_IDS.list:
      return Option.some('list')
    case NBT_TAG_IDS.compound:
      return Option.some('compound')
    case NBT_TAG_IDS.intArray:
      return Option.some('intArray')
    case NBT_TAG_IDS.longArray:
      return Option.some('longArray')
    default:
      return Option.none()
  }
}

export const tagId = (type: NbtTagType): Result.Result<NbtTagId, NbtFormatError> =>
  Object.prototype.hasOwnProperty.call(NBT_TAG_IDS, type)
    ? Result.succeed(Brand.nominal<NbtTagId>()(NBT_TAG_IDS[type]))
    : Result.fail(nbtError(`unknown NBT tag type ${String(type)}`))

export const assertInteger = (
  name: unknown,
  value: unknown,
  minimum: unknown,
  maximum: unknown,
): Result.Result<NbtInteger, NbtFormatError> => {
  if (
    typeof name !== 'string' ||
    typeof value !== 'number' ||
    typeof minimum !== 'number' ||
    typeof maximum !== 'number' ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum > maximum ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return Result.fail(nbtError(`${String(name)} must be an integer in [${String(minimum)}, ${String(maximum)}]`))
  }
  return Result.succeed(Brand.nominal<NbtInteger>()(value))
}

export const assertLong = (value: bigint): Result.Result<bigint, NbtFormatError> =>
  typeof value === 'bigint' && value >= -0x8000000000000000n && value <= 0x7fffffffffffffffn
    ? Result.succeed(value)
    : Result.fail(nbtError('long value is outside the signed 64-bit range'))
