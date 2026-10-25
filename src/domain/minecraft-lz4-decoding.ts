/* oxlint-disable no-bitwise -- LZ4 block fields are bit-packed by the format. */

import {
  assertInput,
  ByteWriter,
  LZ4_BLOCK_HEADER_BYTES,
  LZ4_BLOCK_MAGIC,
  LZ4_COMPRESSION_METHOD_LZ4,
  LZ4_COMPRESSION_METHOD_RAW,
  LZ4_COMPRESSION_LEVEL_BASE,
  LZ4_DEFAULT_SEED,
  lz4Error,
  readUint32LittleEndian,
  resolveMaxBytes,
  xxHash32,
} from './minecraft-lz4-format.js'
import type { MinecraftLz4Error, MinecraftLz4Options } from './minecraft-lz4-format.js'
import { Result } from 'effect'
import { assertDefined } from './assert-defined.js'

class RecentBytes {
  private readonly bytes = new Uint8Array(65536)
  private lengthValue = 0
  private cursor = 0

  reset(): void {
    this.lengthValue = 0
    this.cursor = 0
  }

  get length(): number {
    return this.lengthValue
  }

  append(value: number): void {
    this.bytes[this.cursor] = value
    this.cursor = (this.cursor + 1) % this.bytes.byteLength
    this.lengthValue = Math.min(this.lengthValue + 1, this.bytes.byteLength)
  }

  getFromEnd(offset: number): Result.Result<number, MinecraftLz4Error> {
    const index = (this.cursor - offset + this.bytes.byteLength) % this.bytes.byteLength
    return Result.succeed(new DataView(this.bytes.buffer).getUint8(index))
  }
}

class DecodeOutput {
  private readonly chunks: Uint8Array[] = []
  private readonly current = new ByteWriter()
  private readonly history = new RecentBytes()
  private total = 0
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  get byteLength(): number {
    return this.total
  }

  startBlock(): void {
    this.history.reset()
    this.current.clear()
  }

  append(value: number): Result.Result<void, MinecraftLz4Error> {
    if (this.total >= this.maxBytes) return Result.fail(lz4Error('decode', `decompressed output exceeds maxBytes ${String(this.maxBytes)}`))
    this.current.writeByte(value)
    this.history.append(value)
    this.total += 1
    return Result.succeed(undefined)
  }

  copyMatch(offset: number, length: number): Result.Result<void, MinecraftLz4Error> {
    return Result.gen(function* (this: DecodeOutput) {
      if (offset > this.history.length) return yield* Result.fail(lz4Error('decode', `match offset ${String(offset)} exceeds available history`))
      for (let index = 0; index < length; index += 1) {
        const value = yield* this.history.getFromEnd(offset)
        yield* this.append(value)
      }
      return undefined
    }.bind(this))
  }

  finishBlock(): Uint8Array {
    const block = this.current.toUint8Array()
    this.chunks.push(block)
    this.current.clear()
    return block
  }

  toUint8Array(): Uint8Array {
    const result = new Uint8Array(this.total)
    let offset = 0
    for (const chunk of this.chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
}

const readLength = (block: Uint8Array, state: { offset: number }, initial: number): Result.Result<number, MinecraftLz4Error> =>
  Result.gen(function* () {
    if (initial < 15) return initial
    let length = 15
    while (true) {
      if (state.offset >= block.byteLength) return yield* Result.fail(lz4Error('decode', 'length extension is truncated', state.offset))
      const value = yield* Result.mapError(
        assertDefined(block[state.offset++], 'readLength: offset was within block.byteLength'),
        (reason) => lz4Error('decode', reason, state.offset - 1),
      )
      length += value
      if (value !== 255) return length
    }
  })

const decodeLz4Block = (block: Uint8Array, output: DecodeOutput): Result.Result<void, MinecraftLz4Error> =>
  Result.gen(function* () {
    const state = { offset: 0 }
    while (state.offset < block.byteLength) {
      const token = yield* Result.mapError(
        assertDefined(block[state.offset++], 'decodeLz4Block: offset was within block.byteLength'),
        (reason) => lz4Error('decode', reason, state.offset - 1),
      )
      const literalLength = yield* readLength(block, state, token >>> 4)
      if (literalLength > block.byteLength - state.offset) return yield* Result.fail(lz4Error('decode', 'literal run exceeds the compressed block', state.offset))
      for (let index = 0; index < literalLength; index += 1) {
        const value = yield* Result.mapError(
          assertDefined(block[state.offset++], 'decodeLz4Block: literal run offset out of range'),
          (reason) => lz4Error('decode', reason, state.offset - 1),
        )
        yield* output.append(value)
      }
      if (state.offset === block.byteLength) return undefined
      if (state.offset + 2 > block.byteLength) return yield* Result.fail(lz4Error('decode', 'match offset is truncated', state.offset))
      const matchOffsetLow = yield* Result.mapError(
        assertDefined(block[state.offset], 'decodeLz4Block: missing match offset low byte'),
        (reason) => lz4Error('decode', reason, state.offset),
      )
      const matchOffsetHigh = yield* Result.mapError(
        assertDefined(block[state.offset + 1], 'decodeLz4Block: missing match offset high byte'),
        (reason) => lz4Error('decode', reason, state.offset + 1),
      )
      const matchOffset = matchOffsetLow | (matchOffsetHigh << 8)
      state.offset += 2
      if (matchOffset === 0) return yield* Result.fail(lz4Error('decode', 'match offset must be non-zero', state.offset - 2))
      const matchLength = (yield* readLength(block, state, token & 0x0f)) + 4
      yield* output.copyMatch(matchOffset, matchLength)
    }
    return undefined
  })

const readLengthField = (input: Uint8Array, offset: number, name: string): Result.Result<number, MinecraftLz4Error> =>
  Result.gen(function* () {
    const value = yield* readUint32LittleEndian(input, offset)
    if (value > 0x7fffffff) return yield* Result.fail(lz4Error('decode', `${name} must be non-negative`, offset))
    return value
  })

const assertBlockMagic = (input: Uint8Array, offset: number): Result.Result<void, MinecraftLz4Error> => {
  for (let index = 0; index < LZ4_BLOCK_MAGIC.byteLength; index += 1) {
    if (input[offset + index] !== LZ4_BLOCK_MAGIC[index]) return Result.fail(lz4Error('decode', 'invalid block magic', offset + index))
  }
  return Result.succeed(undefined)
}

export const decodeLz4BlockStream = (input: Uint8Array, options?: MinecraftLz4Options): Result.Result<Uint8Array, MinecraftLz4Error> =>
  Result.gen(function* () {
    const maxBytesOption = yield* Result.try({
      try: () => options?.maxBytes,
      catch: () => lz4Error('decode', 'options.maxBytes could not be read'),
    })
    const maxBytes = yield* resolveMaxBytes('decode', maxBytesOption)
    yield* assertInput('decode', input)
    const bytes = yield* Result.try({
      try: () => input.slice(),
      catch: () => lz4Error('decode', 'input could not be copied'),
    })
    const output = new DecodeOutput(maxBytes)
    let offset = 0

    while (true) {
      if (offset + LZ4_BLOCK_HEADER_BYTES > bytes.byteLength) return yield* Result.fail(lz4Error('decode', 'block header is truncated', offset))
      const headerOffset = offset
      yield* assertBlockMagic(bytes, headerOffset)
      const token = yield* Result.mapError(
        assertDefined(bytes[headerOffset + 8], 'decodeLz4BlockStream: offset was within input.byteLength'),
        (reason) => lz4Error('decode', reason, headerOffset + 8),
      )
      const compressionMethod = token & 0xf0
      const compressionLevel = token & 0x0f
      if (compressionMethod !== LZ4_COMPRESSION_METHOD_RAW && compressionMethod !== LZ4_COMPRESSION_METHOD_LZ4) {
        return yield* Result.fail(lz4Error('decode', `unsupported compression method ${String(compressionMethod)}`, offset + 8))
      }
      const blockMaximum = 1 << (LZ4_COMPRESSION_LEVEL_BASE + compressionLevel)
      const compressedLength = yield* readLengthField(bytes, offset + 9, 'compressed length')
      const originalLength = yield* readLengthField(bytes, offset + 13, 'original length')
      const checksum = yield* readUint32LittleEndian(bytes, offset + 17)
      offset += LZ4_BLOCK_HEADER_BYTES

      if (compressedLength === 0 && originalLength === 0) {
        if (checksum !== 0) return yield* Result.fail(lz4Error('decode', 'empty block checksum must be zero', offset - 4))
        break
      }
      if (compressedLength === 0 || originalLength === 0) return yield* Result.fail(lz4Error('decode', 'data blocks must not be empty', offset - LZ4_BLOCK_HEADER_BYTES))
      if (originalLength > blockMaximum) return yield* Result.fail(lz4Error('decode', 'original length exceeds the declared block size', offset - 8))
      if (compressionMethod === LZ4_COMPRESSION_METHOD_RAW && compressedLength !== originalLength) {
        return yield* Result.fail(lz4Error('decode', 'raw block lengths must match', offset - 12))
      }
      if (originalLength > maxBytes || output.byteLength > maxBytes - originalLength) {
        return yield* Result.fail(lz4Error('decode', `decompressed output exceeds maxBytes ${String(maxBytes)}`, offset - 8))
      }
      if (compressedLength > bytes.byteLength - offset) return yield* Result.fail(lz4Error('decode', 'block data is truncated', offset))

      const blockOffset = offset
      const block = yield* Result.try({
        try: () => bytes.slice(blockOffset, blockOffset + compressedLength),
        catch: () => lz4Error('decode', 'block could not be copied', blockOffset),
      })
      offset += compressedLength
      output.startBlock()
      if (compressionMethod === LZ4_COMPRESSION_METHOD_RAW) {
        for (const value of block) yield* output.append(value)
      } else {
        yield* decodeLz4Block(block, output)
      }
      const decodedBlock = output.finishBlock()
      if (decodedBlock.byteLength !== originalLength) {
        return yield* Result.fail(lz4Error('decode', 'decoded block length does not match the header', offset - compressedLength))
      }
      if ((yield* xxHash32(decodedBlock, LZ4_DEFAULT_SEED)) !== checksum) {
        return yield* Result.fail(lz4Error('decode', 'block checksum does not match', offset - compressedLength - LZ4_BLOCK_HEADER_BYTES + 17))
      }
    }

    if (offset !== bytes.byteLength) return yield* Result.fail(lz4Error('decode', 'trailing bytes follow the block stream', offset))
    return output.toUint8Array()
  })
