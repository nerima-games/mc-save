import { NBT_TAG_IDS } from './minecraft-nbt-types.js'
import type { NbtDocument, NbtTag } from './minecraft-nbt-types.js'
import { encodeModifiedUtf8 } from './minecraft-utf8.js'
import { nbtError, type ResolvedNbtCodecOptions } from './minecraft-nbt-codec-options.js'
import { assertInteger, assertLong, tagId } from './minecraft-nbt-codec-support.js'

class NbtWriter {
  private bytes: Uint8Array
  private length = 0
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
    this.bytes = new Uint8Array(Math.min(1024, maxBytes))
  }

  private ensure(size: number): void {
    assertInteger('write size', size, 0, Number.MAX_SAFE_INTEGER)
    if (size > this.maxBytes - this.length) throw nbtError(`encoded NBT exceeds maxBytes ${String(this.maxBytes)}`)
    const required = this.length + size
    if (required <= this.bytes.byteLength) return

    let capacity = this.bytes.byteLength
    while (capacity < required) {
      capacity = Math.min(this.maxBytes, Math.max(capacity + 1, capacity * 2))
    }
    const expanded = new Uint8Array(capacity)
    expanded.set(this.bytes.subarray(0, this.length))
    this.bytes = expanded
  }

  writeU8(value: number): void {
    assertInteger('unsigned byte', value, 0, 0xff)
    this.ensure(1)
    this.bytes[this.length] = value
    this.length += 1
  }

  writeI8(value: number): void {
    assertInteger('byte', value, -0x80, 0x7f)
    this.ensure(1)
    new DataView(this.bytes.buffer).setInt8(this.length, value)
    this.length += 1
  }

  writeU16(value: number): void {
    assertInteger('unsigned short', value, 0, 0xffff)
    this.ensure(2)
    new DataView(this.bytes.buffer).setUint16(this.length, value, false)
    this.length += 2
  }

  writeI16(value: number): void {
    assertInteger('short', value, -0x8000, 0x7fff)
    this.ensure(2)
    new DataView(this.bytes.buffer).setInt16(this.length, value, false)
    this.length += 2
  }

  writeI32(value: number): void {
    assertInteger('int', value, -0x80000000, 0x7fffffff)
    this.ensure(4)
    new DataView(this.bytes.buffer).setInt32(this.length, value, false)
    this.length += 4
  }

  writeI64(value: bigint): void {
    assertLong(value)
    this.ensure(8)
    new DataView(this.bytes.buffer).setBigInt64(this.length, value, false)
    this.length += 8
  }

  writeFloat32(value: number): void {
    if (typeof value !== 'number') throw nbtError('float value must be a number')
    this.ensure(4)
    new DataView(this.bytes.buffer).setFloat32(this.length, value, false)
    this.length += 4
  }

  writeFloat64(value: number): void {
    if (typeof value !== 'number') throw nbtError('double value must be a number')
    this.ensure(8)
    new DataView(this.bytes.buffer).setFloat64(this.length, value, false)
    this.length += 8
  }

  writeBytes(value: Uint8Array): void {
    this.ensure(value.byteLength)
    this.bytes.set(value, this.length)
    this.length += value.byteLength
  }

  toBytes(): Uint8Array {
    return this.bytes.slice(0, this.length)
  }
}

const assertStringLimit = (value: string, options: ResolvedNbtCodecOptions): Uint8Array => {
  if (typeof value !== 'string') throw nbtError('NBT string must be a string')
  const bytes = encodeModifiedUtf8(value)
  if (bytes.byteLength > options.maxStringBytes) {
    throw nbtError(`NBT string exceeds maxStringBytes ${String(options.maxStringBytes)}`)
  }
  return bytes
}

const writeString = (writer: NbtWriter, value: string, options: ResolvedNbtCodecOptions): void => {
  const bytes = assertStringLimit(value, options)
  writer.writeU16(bytes.byteLength)
  writer.writeBytes(bytes)
}

class NbtEncodeState {
  elements = 0
  readonly options: ResolvedNbtCodecOptions

  constructor(options: ResolvedNbtCodecOptions) {
    this.options = options
  }

  count(value: number): void {
    assertInteger('element count', value, 0, Number.MAX_SAFE_INTEGER)
    if (value > this.options.maxElements - this.elements) {
      throw nbtError(`NBT exceeds maxElements ${String(this.options.maxElements)}`)
    }
    this.elements += value
  }

  depth(value: number): void {
    if (value > this.options.maxDepth) throw nbtError(`NBT exceeds maxDepth ${String(this.options.maxDepth)}`)
  }
}

const writePayload = (writer: NbtWriter, tag: NbtTag, depth: number, state: NbtEncodeState): void => {
  switch (tag.type) {
    case 'end':
      throw nbtError('end tags cannot be encoded as a named value')
    case 'byte':
      writer.writeI8(tag.value)
      return
    case 'short':
      writer.writeI16(tag.value)
      return
    case 'int':
      writer.writeI32(tag.value)
      return
    case 'long':
      writer.writeI64(tag.value)
      return
    case 'float':
      writer.writeFloat32(tag.value)
      return
    case 'double':
      writer.writeFloat64(tag.value)
      return
    case 'byteArray':
      if (!(tag.value instanceof Uint8Array)) throw nbtError('byteArray value must be a Uint8Array')
      assertInteger('byteArray length', tag.value.byteLength, 0, 0x7fffffff)
      state.count(tag.value.byteLength)
      writer.writeI32(tag.value.byteLength)
      writer.writeBytes(tag.value)
      return
    case 'string':
      writeString(writer, tag.value, state.options)
      return
    case 'list':
      state.depth(depth)
      assertInteger('list length', tag.values.length, 0, 0x7fffffff)
      if (tag.elementType === 'end' && tag.values.length > 0) throw nbtError('an end-typed list must be empty')
      for (const value of tag.values) {
        if (value.type !== tag.elementType) {
          throw nbtError(`list value type ${value.type} does not match ${tag.elementType}`)
        }
      }
      state.count(tag.values.length)
      writer.writeU8(tagId(tag.elementType))
      writer.writeI32(tag.values.length)
      for (const value of tag.values) writePayload(writer, value, depth + 1, state)
      return
    case 'compound':
      state.depth(depth)
      assertInteger('compound entry count', tag.entries.length, 0, 0x7fffffff)
      state.count(tag.entries.length)
      {
        const names = new Set<string>()
        for (const entry of tag.entries) {
          const [name, value] = entry
          if (names.has(name)) throw nbtError(`compound contains duplicate name ${JSON.stringify(name)}`)
          names.add(name)
          writer.writeU8(tagId(value.type))
          writeString(writer, name, state.options)
          writePayload(writer, value, depth + 1, state)
        }
      }
      writer.writeU8(NBT_TAG_IDS.end)
      return
    case 'intArray':
      assertInteger('intArray length', tag.value.length, 0, 0x7fffffff)
      state.count(tag.value.length)
      writer.writeI32(tag.value.length)
      for (const value of tag.value) writer.writeI32(value)
      return
    case 'longArray':
      assertInteger('longArray length', tag.value.length, 0, 0x7fffffff)
      state.count(tag.value.length)
      writer.writeI32(tag.value.length)
      for (const value of tag.value) writer.writeI64(value)
      return
    default:
      throw nbtError('unknown NBT tag type')
  }
}

const writeDocument = (writer: NbtWriter, document: NbtDocument, options: ResolvedNbtCodecOptions): void => {
  if (typeof document.name !== 'string') throw nbtError('document name must be a string')
  if (document.root === null || typeof document.root !== 'object' || document.root.type !== 'compound') {
    throw nbtError('document root must be a compound')
  }
  writer.writeU8(NBT_TAG_IDS.compound)
  writeString(writer, document.name, options)
  writePayload(writer, document.root, 1, new NbtEncodeState(options))
}

export const encodeNbtDocument = (document: NbtDocument, options: ResolvedNbtCodecOptions): Uint8Array => {
  if (document === null || typeof document !== 'object') throw nbtError('document must be an object')
  const writer = new NbtWriter(options.maxBytes)
  writeDocument(writer, document, options)
  return writer.toBytes()
}
