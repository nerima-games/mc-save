import { Result } from 'effect'
import { NBT_TAG_IDS } from './minecraft-nbt-types.js'
import { isMinecraftNbtDocument } from './minecraft-nbt-validation.js'
import type { NbtDocument, NbtFormatError, NbtNonEndTag } from './minecraft-nbt-types.js'
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

  private ensure(size: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* assertInteger('write size', size, 0, Number.MAX_SAFE_INTEGER)
      if (size > this.maxBytes - this.length) {
        return yield* Result.fail(nbtError(`encoded NBT exceeds maxBytes ${String(this.maxBytes)}`))
      }
      const required = this.length + size
      if (required <= this.bytes.byteLength) return
      let capacity = this.bytes.byteLength
      while (capacity < required) {
        capacity = Math.min(this.maxBytes, Math.max(capacity + 1, capacity * 2))
      }
      const expanded = new Uint8Array(capacity)
      expanded.set(this.bytes.subarray(0, this.length))
      this.bytes = expanded
    }.bind(this))
  }

  writeU8(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* assertInteger('unsigned byte', value, 0, 0xff)
      yield* this.ensure(1)
      this.bytes[this.length] = value
      this.length += 1
    }.bind(this))
  }

  writeI8(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* assertInteger('byte', value, -0x80, 0x7f)
      yield* this.ensure(1)
      new DataView(this.bytes.buffer).setInt8(this.length, value)
      this.length += 1
    }.bind(this))
  }

  writeU16(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* assertInteger('unsigned short', value, 0, 0xffff)
      yield* this.ensure(2)
      new DataView(this.bytes.buffer).setUint16(this.length, value, false)
      this.length += 2
    }.bind(this))
  }

  writeI16(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* assertInteger('short', value, -0x8000, 0x7fff)
      yield* this.ensure(2)
      new DataView(this.bytes.buffer).setInt16(this.length, value, false)
      this.length += 2
    }.bind(this))
  }

  writeI32(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* assertInteger('int', value, -0x80000000, 0x7fffffff)
      yield* this.ensure(4)
      new DataView(this.bytes.buffer).setInt32(this.length, value, false)
      this.length += 4
    }.bind(this))
  }

  writeI64(value: bigint): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* assertLong(value)
      yield* this.ensure(8)
      new DataView(this.bytes.buffer).setBigInt64(this.length, value, false)
      this.length += 8
    }.bind(this))
  }

  writeFloat32(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* this.ensure(4)
      new DataView(this.bytes.buffer).setFloat32(this.length, value, false)
      this.length += 4
    }.bind(this))
  }

  writeFloat64(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      yield* this.ensure(8)
      new DataView(this.bytes.buffer).setFloat64(this.length, value, false)
      this.length += 8
    }.bind(this))
  }

  writeBytes(value: Uint8Array): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtWriter) {
      const bytes = yield* Result.try({
        try: () => value.slice(),
        catch: () => nbtError('NBT byte input must be readable'),
      })
      yield* this.ensure(bytes.byteLength)
      this.bytes.set(bytes, this.length)
      this.length += bytes.byteLength
    }.bind(this))
  }

  toBytes(): Result.Result<Uint8Array, NbtFormatError> {
    return Result.try({
      try: () => this.bytes.slice(0, this.length),
      catch: () => nbtError('encoded NBT bytes could not be copied'),
    })
  }
}

const assertStringLimit = (
  value: string,
  options: ResolvedNbtCodecOptions,
): Result.Result<Uint8Array, NbtFormatError> =>
  Result.gen(function* () {
    const bytes = yield* Result.mapError(
      encodeModifiedUtf8(value),
      () => nbtError('NBT string is invalid modified UTF-8'),
    )
    if (bytes.byteLength > options.maxStringBytes) {
      return yield* Result.fail(
        nbtError(`NBT string exceeds maxStringBytes ${String(options.maxStringBytes)}`),
      )
    }
    return bytes
  })

const writeString = (
  writer: NbtWriter,
  value: string,
  options: ResolvedNbtCodecOptions,
): Result.Result<void, NbtFormatError> =>
  Result.gen(function* () {
    const bytes = yield* assertStringLimit(value, options)
    yield* writer.writeU16(bytes.byteLength)
    yield* writer.writeBytes(bytes)
  })

class NbtEncodeState {
  elements = 0
  readonly options: ResolvedNbtCodecOptions

  constructor(options: ResolvedNbtCodecOptions) {
    this.options = options
  }

  count(value: number): Result.Result<void, NbtFormatError> {
    return Result.gen(function* (this: NbtEncodeState) {
      yield* assertInteger('element count', value, 0, Number.MAX_SAFE_INTEGER)
      if (value > this.options.maxElements - this.elements) {
        return yield* Result.fail(nbtError(`NBT exceeds maxElements ${String(this.options.maxElements)}`))
      }
      this.elements += value
    }.bind(this))
  }

  depth(value: number): Result.Result<void, NbtFormatError> {
    return value <= this.options.maxDepth
      ? Result.succeed(undefined)
      : Result.fail(nbtError(`NBT exceeds maxDepth ${String(this.options.maxDepth)}`))
  }
}

const writePayload = (
  writer: NbtWriter,
  tag: NbtNonEndTag,
  depth: number,
  state: NbtEncodeState,
): Result.Result<void, NbtFormatError> =>
  Result.gen(function* () {
    switch (tag.type) {
      case 'byte':
        yield* writer.writeI8(tag.value)
        return
      case 'short':
        yield* writer.writeI16(tag.value)
        return
      case 'int':
        yield* writer.writeI32(tag.value)
        return
      case 'long':
        yield* writer.writeI64(tag.value)
        return
      case 'float':
        yield* writer.writeFloat32(tag.value)
        return
      case 'double':
        yield* writer.writeFloat64(tag.value)
        return
      case 'byteArray': {
        const length = tag.value.byteLength
        yield* assertInteger('byteArray length', length, 0, 0x7fffffff)
        yield* state.count(length)
        yield* writer.writeI32(length)
        yield* writer.writeBytes(tag.value)
        return
      }
      case 'string':
        yield* writeString(writer, tag.value, state.options)
        return
      case 'list': {
        const values = tag.values
        const length = values.length
        yield* state.depth(depth)
        yield* assertInteger('list length', length, 0, 0x7fffffff)
        yield* state.count(length)
        yield* writer.writeU8(yield* tagId(tag.elementType))
        yield* writer.writeI32(length)
        for (const value of values) {
          yield* writePayload(writer, value, depth + 1, state)
        }
        return
      }
      case 'compound': {
        const entries = tag.entries
        const length = entries.length
        yield* state.depth(depth)
        yield* assertInteger('compound entry count', length, 0, 0x7fffffff)
        yield* state.count(length)
        for (const [name, value] of entries) {
          yield* writer.writeU8(yield* tagId(value.type))
          yield* writeString(writer, name, state.options)
          yield* writePayload(writer, value, depth + 1, state)
        }
        yield* writer.writeU8(NBT_TAG_IDS.end)
        return
      }
      case 'intArray': {
        const values = tag.value
        const length = values.length
        yield* assertInteger('intArray length', length, 0, 0x7fffffff)
        yield* state.count(length)
        yield* writer.writeI32(length)
        for (const value of values) yield* writer.writeI32(value)
        return
      }
      case 'longArray': {
        const values = tag.value
        const length = values.length
        yield* assertInteger('longArray length', length, 0, 0x7fffffff)
        yield* state.count(length)
        yield* writer.writeI32(length)
        for (const value of values) yield* writer.writeI64(value)
        return
      }
    }
  })

const writeDocument = (
  writer: NbtWriter,
  document: NbtDocument,
  options: ResolvedNbtCodecOptions,
): Result.Result<void, NbtFormatError> =>
  Result.gen(function* () {
    yield* writer.writeU8(NBT_TAG_IDS.compound)
    yield* writeString(writer, document.name, options)
    yield* writePayload(writer, document.root, 1, new NbtEncodeState(options))
  })

export const encodeNbtDocument = (
  document: NbtDocument,
  options: ResolvedNbtCodecOptions,
): Result.Result<Uint8Array, NbtFormatError> =>
  Result.gen(function* () {
    if (document === null || typeof document !== 'object') {
      return yield* Result.fail(nbtError('document must be an object'))
    }
    const snapshot = yield* Result.try({
      try: () => structuredClone(document),
      catch: () => nbtError('document could not be snapshotted'),
    })
    if (!isMinecraftNbtDocument(snapshot)) {
      return yield* Result.fail(nbtError('document is not a valid NBT document'))
    }
    const writer = new NbtWriter(options.maxBytes)
    yield* writeDocument(writer, snapshot, options)
    return yield* writer.toBytes()
  })
