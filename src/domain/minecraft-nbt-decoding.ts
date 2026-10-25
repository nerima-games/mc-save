import { Option, Result } from 'effect'
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
import type { NbtCompound, NbtDocument, NbtFormatError, NbtNonEndTag } from './minecraft-nbt-types.js'
import { decodeModifiedUtf8 } from './minecraft-utf8.js'
import type { ResolvedNbtCodecOptions } from './minecraft-nbt-codec-options.js'
import { nbtError } from './minecraft-nbt-codec-options.js'
import { assertInteger, tagTypeFromId, type NbtPayloadTagType } from './minecraft-nbt-codec-support.js'

const asArrayBuffer = (buffer: ArrayBufferLike): Result.Result<ArrayBuffer, NbtFormatError> =>
  buffer instanceof ArrayBuffer
    ? Result.succeed(buffer)
    : Result.fail(nbtError('expected an ArrayBuffer-backed Uint8Array'))
class NbtReader {
  private readonly view: DataView
  private offset = 0
  private elements = 0
  private readonly bytes: Uint8Array
  readonly options: ResolvedNbtCodecOptions

  constructor(bytes: Uint8Array, view: DataView, options: ResolvedNbtCodecOptions) {
    this.bytes = bytes
    this.options = options
    this.view = view
  }

  private require(length: number): Result.Result<void, NbtFormatError> {
    return length <= this.bytes.byteLength - this.offset
      ? Result.succeed(undefined)
      : Result.fail(nbtError('unexpected end of input', this.offset))
  }

  private read(length: number): Result.Result<number, NbtFormatError> {
    return Result.gen(function* (this: NbtReader) {
      yield* this.require(length)
      const start = this.offset
      this.offset += length
      return start
    }.bind(this))
  }

  readU8(): Result.Result<number, NbtFormatError> {
    return Result.map(this.read(1), (start) => this.view.getUint8(start))
  }

  readI8(): Result.Result<number, NbtFormatError> {
    return Result.map(this.read(1), (start) => this.view.getInt8(start))
  }

  readU16(): Result.Result<number, NbtFormatError> {
    return Result.map(this.read(2), (start) => this.view.getUint16(start, false))
  }

  readI16(): Result.Result<number, NbtFormatError> {
    return Result.map(this.read(2), (start) => this.view.getInt16(start, false))
  }

  readI32(): Result.Result<number, NbtFormatError> {
    return Result.map(this.read(4), (start) => this.view.getInt32(start, false))
  }

  readI64(): Result.Result<bigint, NbtFormatError> {
    return Result.map(this.read(8), (start) => this.view.getBigInt64(start, false))
  }

  readFloat32(): Result.Result<number, NbtFormatError> {
    return Result.map(this.read(4), (start) => this.view.getFloat32(start, false))
  }

  readFloat64(): Result.Result<number, NbtFormatError> {
    return Result.map(this.read(8), (start) => this.view.getFloat64(start, false))
  }

  readBytes(length: number): Result.Result<Uint8Array, NbtFormatError> {
    return Result.gen(function* (this: NbtReader) {
      const safeLength = yield* assertInteger('byte length', length, 0, 0x7fffffff)
      const start = yield* this.read(safeLength)
      return yield* Result.try({
        try: () => this.bytes.slice(start, start + safeLength),
        catch: () => nbtError('byte sequence could not be copied', start),
      })
    }.bind(this))
  }

  readString(): Result.Result<string, NbtFormatError> {
    return Result.gen(function* (this: NbtReader) {
      const lengthOffset = this.offset
      const length = yield* this.readU16()
      if (length > this.options.maxStringBytes) {
        return yield* Result.fail(nbtError(`NBT string exceeds maxStringBytes ${String(this.options.maxStringBytes)}`, lengthOffset))
      }
      const bytes = yield* this.readBytes(length)
      return yield* Result.mapError(decodeModifiedUtf8(bytes), (error) => nbtError(error.message, lengthOffset))
    }.bind(this))
  }

  count(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtReader) {
      const safeValue = yield* assertInteger('element count', value, 0, 0x7fffffff)
      if (safeValue > this.options.maxElements - this.elements) {
        return yield* Result.fail(nbtError(`NBT exceeds maxElements ${String(this.options.maxElements)}`, this.offset))
      }
      this.elements += safeValue
      return undefined
    }.bind(this))
  }

  depth(value: number): Result.Result<void, NbtFormatError> {
    return value > this.options.maxDepth
      ? Result.fail(nbtError(`NBT exceeds maxDepth ${String(this.options.maxDepth)}`, this.offset))
      : Result.succeed(undefined)
  }

  readTagPayload(type: NbtPayloadTagType, depth: number): Result.Result<NbtNonEndTag, NbtFormatError> {
    return Result.gen(function* (this: NbtReader) {
      // oxlint-disable-next-line default-case -- tag ids are validated before this closed union reaches the payload reader.
      switch (type) {
        case 'byte': { const value = yield* this.readI8(); return yield* nbtByte(value) }
        case 'short': { const value = yield* this.readI16(); return yield* nbtShort(value) }
        case 'int': { const value = yield* this.readI32(); return yield* nbtInt(value) }
        case 'long': { const value = yield* this.readI64(); return yield* nbtLong(value) }
        case 'float': { const value = yield* this.readFloat32(); return yield* nbtFloat(value) }
        case 'double': { const value = yield* this.readFloat64(); return yield* nbtDouble(value) }
        case 'byteArray': {
          const length = yield* this.readI32()
          yield* this.count(length)
          return yield* nbtByteArray(yield* this.readBytes(length))
        }
        case 'string': return yield* nbtString(yield* this.readString())
        case 'list': {
          yield* this.depth(depth)
          const elementTypeId = yield* this.readU8()
          const elementTypeOption = tagTypeFromId(elementTypeId)
          if (Option.isNone(elementTypeOption)) {
            return yield* Result.fail(nbtError(`unknown list element tag id ${String(elementTypeId)}`, this.offset - 1))
          }
          const elementType = elementTypeOption.value
          const length = yield* this.readI32()
          if (elementType === 'end' && length > 0) return yield* Result.fail(nbtError('an end-typed list must be empty', this.offset - 4))
          yield* this.count(length)
          const values: NbtNonEndTag[] = []
          if (elementType !== 'end') {
            for (let index = 0; index < length; index += 1) values.push(yield* this.readTagPayload(elementType, depth + 1))
          }
          return yield* nbtList(elementType, values)
        }
        case 'compound': return yield* this.readCompound(depth)
        case 'intArray': {
          const length = yield* this.readI32()
          yield* this.count(length)
          const values: number[] = []
          for (let index = 0; index < length; index += 1) values.push(yield* this.readI32())
          return yield* nbtIntArray(values)
        }
        case 'longArray': {
          const length = yield* this.readI32()
          yield* this.count(length)
          const values: bigint[] = []
          for (let index = 0; index < length; index += 1) values.push(yield* this.readI64())
          return yield* nbtLongArray(values)
        }
      }
    }.bind(this))
  }

  readCompound(depth: number): Result.Result<NbtCompound, NbtFormatError> {
    return Result.gen(function* (this: NbtReader) {
      yield* this.depth(depth)
      const entries: Array<readonly [name: string, value: NbtNonEndTag]> = []
      const names = new Set<string>()
      while (true) {
        const typeIdOffset = this.offset
        const valueTypeId = yield* this.readU8()
        const valueTypeOption = tagTypeFromId(valueTypeId)
        if (Option.isNone(valueTypeOption)) return yield* Result.fail(nbtError(`unknown tag id ${String(valueTypeId)}`, typeIdOffset))
        const valueType = valueTypeOption.value
        if (valueType === 'end') break
        const name = yield* this.readString()
        if (names.has(name)) return yield* Result.fail(nbtError(`compound contains duplicate name ${JSON.stringify(name)}`, typeIdOffset))
        names.add(name)
        yield* this.count(1)
        entries.push([name, yield* this.readTagPayload(valueType, depth + 1)])
      }
      return yield* nbtCompound(entries)
    }.bind(this))
  }

  atEnd(): boolean {
    return this.offset === this.bytes.byteLength
  }

  position(): number {
    return this.offset
  }
}

export const decodeNbtBytes = (bytes: Uint8Array, options: ResolvedNbtCodecOptions): Result.Result<NbtDocument, NbtFormatError> =>
  Result.gen(function* () {
    const arrayBuffer = yield* asArrayBuffer(bytes.buffer)
    const view = yield* Result.try({
      try: () => new DataView(arrayBuffer, bytes.byteOffset, bytes.byteLength),
      catch: () => nbtError('input must be an ArrayBuffer-backed Uint8Array'),
    })
    const reader = new NbtReader(bytes, view, options)
    const rootTypeId = yield* reader.readU8()
    if (rootTypeId !== NBT_TAG_IDS.compound) {
      return yield* Result.fail(nbtError(`root tag must be a compound, received id ${String(rootTypeId)}`, 0))
    }
    const name = yield* reader.readString()
    const root = yield* reader.readCompound(1)
    if (!reader.atEnd()) return yield* Result.fail(nbtError('trailing bytes after root compound', reader.position()))
    return yield* nbtDocument(name, root)
  })
