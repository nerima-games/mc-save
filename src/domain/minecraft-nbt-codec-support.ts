import { NBT_TAG_IDS } from './minecraft-nbt-types.js'
import type { NbtTagType } from './minecraft-nbt-types.js'
import { nbtError } from './minecraft-nbt-codec-options.js'

export type NbtPayloadTagType = Exclude<NbtTagType, 'end'>

export const tagTypeFromId = (id: number): NbtTagType | undefined => {
  switch (id) {
    case NBT_TAG_IDS.end:
      return 'end'
    case NBT_TAG_IDS.byte:
      return 'byte'
    case NBT_TAG_IDS.short:
      return 'short'
    case NBT_TAG_IDS.int:
      return 'int'
    case NBT_TAG_IDS.long:
      return 'long'
    case NBT_TAG_IDS.float:
      return 'float'
    case NBT_TAG_IDS.double:
      return 'double'
    case NBT_TAG_IDS.byteArray:
      return 'byteArray'
    case NBT_TAG_IDS.string:
      return 'string'
    case NBT_TAG_IDS.list:
      return 'list'
    case NBT_TAG_IDS.compound:
      return 'compound'
    case NBT_TAG_IDS.intArray:
      return 'intArray'
    case NBT_TAG_IDS.longArray:
      return 'longArray'
    default:
      return undefined
  }
}

export const tagId = (type: NbtTagType): number => NBT_TAG_IDS[type]

export const assertInteger = (name: string, value: number, minimum: number, maximum: number): void => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw nbtError(`${name} must be an integer in [${String(minimum)}, ${String(maximum)}]`)
  }
}

export const assertLong = (value: bigint): void => {
  if (typeof value !== 'bigint' || value < -0x8000000000000000n || value > 0x7fffffffffffffffn) {
    throw nbtError('long value is outside the signed 64-bit range')
  }
}
