import {
  NBT_TAG_IDS,
  nbtByte,
  nbtByteArray,
  nbtCompound,
  nbtDocument,
  nbtDouble,
  nbtFloat,
  nbtInt,
  nbtIntArray,
  nbtList,
  nbtLong,
  nbtLongArray,
  nbtShort,
  nbtString,
} from './minecraft-nbt-types.js'
import type { NbtCompound, NbtDocument, NbtNonEndTag } from './minecraft-nbt-types.js'
import { decodeModifiedUtf8 } from './minecraft-utf8.js'
import type { ResolvedNbtCodecOptions } from './minecraft-nbt-codec-options.js'
import { nbtError } from './minecraft-nbt-codec-options.js'
import { assertInteger, tagTypeFromId, type NbtPayloadTagType } from './minecraft-nbt-codec-support.js'

const asArrayBuffer = (buffer: ArrayBufferLike): ArrayBuffer => {
  if (!(buffer instanceof ArrayBuffer)) throw new TypeError('expected an ArrayBuffer-backed Uint8Array')
  return buffer
}

class NbtReader {
  private readonly view: DataView
  private offset = 0
  private elements = 0
  private readonly bytes: Uint8Array
  readonly options: ResolvedNbtCodecOptions

  constructor(bytes: Uint8Array, options: ResolvedNbtCodecOptions) {
    this.bytes = bytes
    this.options = options
    this.view = new DataView(asArrayBuffer(bytes.buffer), bytes.byteOffset, bytes.byteLength)
  }

  private require(length: number): void {
    if (length > this.bytes.byteLength - this.offset) throw nbtError('unexpected end of input', this.offset)
  }

  private read(length: number): number {
    this.require(length)
    const start = this.offset
    this.offset += length
    return start
  }

  readU8(): number {
    const start = this.read(1)
    return this.view.getUint8(start)
  }

  readI8(): number {
    const start = this.read(1)
    return this.view.getInt8(start)
  }

  readU16(): number {
    const start = this.read(2)
    return this.view.getUint16(start, false)
  }

  readI16(): number {
    const start = this.read(2)
    return this.view.getInt16(start, false)
  }

  readI32(): number {
    const start = this.read(4)
    return this.view.getInt32(start, false)
  }

  readI64(): bigint {
    const start = this.read(8)
    return this.view.getBigInt64(start, false)
  }

  readFloat32(): number {
    const start = this.read(4)
    return this.view.getFloat32(start, false)
  }

  readFloat64(): number {
    const start = this.read(8)
    return this.view.getFloat64(start, false)
  }

  readBytes(length: number): Uint8Array {
    assertInteger('byte length', length, 0, 0x7fffffff)
    const start = this.read(length)
    return this.bytes.slice(start, start + length)
  }

  readString(): string {
    const lengthOffset = this.offset
    const length = this.readU16()
    if (length > this.options.maxStringBytes) {
      throw nbtError(`NBT string exceeds maxStringBytes ${String(this.options.maxStringBytes)}`, lengthOffset)
    }
    const bytes = this.readBytes(length)
    try {
      return decodeModifiedUtf8(bytes)
    } catch (cause) {
      throw nbtError(String(cause).replace(/^(?:Error|TypeError): /, ''), lengthOffset)
    }
  }

  count(value: number): void {
    assertInteger('element count', value, 0, 0x7fffffff)
    if (value > this.options.maxElements - this.elements) {
      throw nbtError(`NBT exceeds maxElements ${String(this.options.maxElements)}`, this.offset)
    }
    this.elements += value
  }

  depth(value: number): void {
    if (value > this.options.maxDepth) throw nbtError(`NBT exceeds maxDepth ${String(this.options.maxDepth)}`, this.offset)
  }

  readTagPayload(type: NbtPayloadTagType, depth: number): NbtNonEndTag {
    // oxlint-disable-next-line default-case -- tag ids are validated before this closed union reaches the payload reader.
    switch (type) {
      case 'byte':
        return nbtByte(this.readI8())
      case 'short':
        return nbtShort(this.readI16())
      case 'int':
        return nbtInt(this.readI32())
      case 'long':
        return nbtLong(this.readI64())
      case 'float':
        return nbtFloat(this.readFloat32())
      case 'double':
        return nbtDouble(this.readFloat64())
      case 'byteArray': {
        const length = this.readI32()
        this.count(length)
        return nbtByteArray(this.readBytes(length))
      }
      case 'string':
        return nbtString(this.readString())
      case 'list': {
        this.depth(depth)
        const elementTypeId = this.readU8()
        const elementType = tagTypeFromId(elementTypeId)
        if (elementType === undefined) throw nbtError(`unknown list element tag id ${String(elementTypeId)}`, this.offset - 1)
        const length = this.readI32()
        if (elementType === 'end' && length > 0) throw nbtError('an end-typed list must be empty', this.offset - 4)
        this.count(length)
        const values: NbtNonEndTag[] = []
        if (elementType !== 'end') {
          for (let index = 0; index < length; index += 1) {
            values.push(this.readTagPayload(elementType, depth + 1))
          }
        }
        return nbtList(elementType, values)
      }
      case 'compound':
        return this.readCompound(depth)
      case 'intArray': {
        const length = this.readI32()
        this.count(length)
        const values: number[] = []
        for (let index = 0; index < length; index += 1) values.push(this.readI32())
        return nbtIntArray(values)
      }
      case 'longArray': {
        const length = this.readI32()
        this.count(length)
        const values: bigint[] = []
        for (let index = 0; index < length; index += 1) values.push(this.readI64())
        return nbtLongArray(values)
      }
    }
  }

  readCompound(depth: number): NbtCompound {
    this.depth(depth)
    const entries: Array<readonly [name: string, value: NbtNonEndTag]> = []
    const names = new Set<string>()
    while (true) {
      const typeIdOffset = this.offset
      const valueTypeId = this.readU8()
      const valueType = tagTypeFromId(valueTypeId)
      if (valueType === undefined) throw nbtError(`unknown tag id ${String(valueTypeId)}`, typeIdOffset)
      if (valueType === 'end') break
      const name = this.readString()
      if (names.has(name)) throw nbtError(`compound contains duplicate name ${JSON.stringify(name)}`, typeIdOffset)
      names.add(name)
      this.count(1)
      entries.push([name, this.readTagPayload(valueType, depth + 1)])
    }
    return nbtCompound(entries)
  }

  atEnd(): boolean {
    return this.offset === this.bytes.byteLength
  }

  position(): number {
    return this.offset
  }
}

export const decodeNbtBytes = (bytes: Uint8Array, options: ResolvedNbtCodecOptions): NbtDocument => {
  const reader = new NbtReader(bytes, options)
  const rootTypeId = reader.readU8()
  if (rootTypeId !== NBT_TAG_IDS.compound) {
    throw nbtError(`root tag must be a compound, received id ${String(rootTypeId)}`, 0)
  }
  const name = reader.readString()
  const root = reader.readCompound(1)
  if (!reader.atEnd()) throw nbtError('trailing bytes after root compound', reader.position())
  return nbtDocument(name, root)
}
