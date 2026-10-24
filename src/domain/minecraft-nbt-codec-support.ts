import { Option, Result } from 'effect'
import { NBT_TAG_IDS } from './minecraft-nbt-types.js'
import type { NbtFormatError, NbtTagType } from './minecraft-nbt-types.js'
import { nbtError } from './minecraft-nbt-codec-options.js'

export type NbtPayloadTagType = Exclude<NbtTagType, 'end'>

export const tagTypeFromId = (id: number): Option.Option<NbtTagType> => {
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

export const tagId = (type: NbtTagType): Result.Result<number, NbtFormatError> =>
  Object.prototype.hasOwnProperty.call(NBT_TAG_IDS, type)
    ? Result.succeed(NBT_TAG_IDS[type])
    : Result.fail(nbtError(`unknown NBT tag type ${String(type)}`))

export const assertInteger = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): Result.Result<number, NbtFormatError> =>
  Number.isInteger(value) && value >= minimum && value <= maximum
    ? Result.succeed(value)
    : Result.fail(nbtError(`${name} must be an integer in [${String(minimum)}, ${String(maximum)}]`))

export const assertLong = (value: bigint): Result.Result<bigint, NbtFormatError> =>
  typeof value === 'bigint' && value >= -0x8000000000000000n && value <= 0x7fffffffffffffffn
    ? Result.succeed(value)
    : Result.fail(nbtError('long value is outside the signed 64-bit range'))
