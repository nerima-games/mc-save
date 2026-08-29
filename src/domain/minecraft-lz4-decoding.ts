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
import type { MinecraftLz4Options } from './minecraft-lz4-format.js'

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

  getFromEnd(offset: number): number {
    const index = (this.cursor - offset + this.bytes.byteLength) % this.bytes.byteLength
    return this.bytes[index]!
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

  append(value: number): void {
    if (this.total >= this.maxBytes) throw lz4Error('decode', `decompressed output exceeds maxBytes ${String(this.maxBytes)}`)
    this.current.writeByte(value)
    this.history.append(value)
    this.total += 1
  }

  copyMatch(offset: number, length: number): void {
    if (offset > this.history.length) throw lz4Error('decode', `match offset ${String(offset)} exceeds available history`)
    for (let index = 0; index < length; index += 1) this.append(this.history.getFromEnd(offset))
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

const readLength = (block: Uint8Array, state: { offset: number }, initial: number): number => {
  if (initial < 15) return initial
  let length = 15
  while (true) {
    if (state.offset >= block.byteLength) throw lz4Error('decode', 'length extension is truncated', state.offset)
    const value = block[state.offset++]!
    length += value
    if (value !== 255) return length
  }
}

const decodeLz4Block = (block: Uint8Array, output: DecodeOutput): void => {
  const state = { offset: 0 }
  while (state.offset < block.byteLength) {
    const token = block[state.offset++]!
    const literalLength = readLength(block, state, token >>> 4)
    if (literalLength > block.byteLength - state.offset) {
      throw lz4Error('decode', 'literal run exceeds the compressed block', state.offset)
    }
    for (let index = 0; index < literalLength; index += 1) output.append(block[state.offset++]!)
    if (state.offset === block.byteLength) return
    if (state.offset + 2 > block.byteLength) throw lz4Error('decode', 'match offset is truncated', state.offset)
    const matchOffset = block[state.offset]! | (block[state.offset + 1]! << 8)
    state.offset += 2
    if (matchOffset === 0) throw lz4Error('decode', 'match offset must be non-zero', state.offset - 2)
    const matchLength = readLength(block, state, token & 0x0f) + 4
    output.copyMatch(matchOffset, matchLength)
  }
}

const readLengthField = (input: Uint8Array, offset: number, name: string): number => {
  const value = readUint32LittleEndian(input, offset)
  if (value > 0x7fffffff) throw lz4Error('decode', `${name} must be non-negative`, offset)
  return value
}

const assertBlockMagic = (input: Uint8Array, offset: number): void => {
  for (let index = 0; index < LZ4_BLOCK_MAGIC.byteLength; index += 1) {
    if (input[offset + index] !== LZ4_BLOCK_MAGIC[index]) throw lz4Error('decode', 'invalid block magic', offset + index)
  }
}

export const decodeLz4BlockStream = (input: Uint8Array, options?: MinecraftLz4Options): Uint8Array => {
  const maxBytes = resolveMaxBytes('decode', options?.maxBytes)
  assertInput('decode', input)
  const output = new DecodeOutput(maxBytes)
  let offset = 0

  while (true) {
    if (offset + LZ4_BLOCK_HEADER_BYTES > input.byteLength) throw lz4Error('decode', 'block header is truncated', offset)
    assertBlockMagic(input, offset)
    const token = input[offset + 8]!
    const compressionMethod = token & 0xf0
    const compressionLevel = token & 0x0f
    if (compressionMethod !== LZ4_COMPRESSION_METHOD_RAW && compressionMethod !== LZ4_COMPRESSION_METHOD_LZ4) {
      throw lz4Error('decode', `unsupported compression method ${String(compressionMethod)}`, offset + 8)
    }
    const blockMaximum = 1 << (LZ4_COMPRESSION_LEVEL_BASE + compressionLevel)
    const compressedLength = readLengthField(input, offset + 9, 'compressed length')
    const originalLength = readLengthField(input, offset + 13, 'original length')
    const checksum = readUint32LittleEndian(input, offset + 17)
    offset += LZ4_BLOCK_HEADER_BYTES

    if (compressedLength === 0 && originalLength === 0) {
      if (checksum !== 0) throw lz4Error('decode', 'empty block checksum must be zero', offset - 4)
      break
    }
    if (compressedLength === 0 || originalLength === 0) throw lz4Error('decode', 'data blocks must not be empty', offset - LZ4_BLOCK_HEADER_BYTES)
    if (originalLength > blockMaximum) throw lz4Error('decode', 'original length exceeds the declared block size', offset - 8)
    if (compressionMethod === LZ4_COMPRESSION_METHOD_RAW && compressedLength !== originalLength) {
      throw lz4Error('decode', 'raw block lengths must match', offset - 12)
    }
    if (originalLength > maxBytes || output.byteLength > maxBytes - originalLength) {
      throw lz4Error('decode', `decompressed output exceeds maxBytes ${String(maxBytes)}`, offset - 8)
    }
    if (compressedLength > input.byteLength - offset) throw lz4Error('decode', 'block data is truncated', offset)

    const block = input.slice(offset, offset + compressedLength)
    offset += compressedLength
    output.startBlock()
    if (compressionMethod === LZ4_COMPRESSION_METHOD_RAW) {
      for (const value of block) output.append(value)
    } else {
      decodeLz4Block(block, output)
    }
    const decodedBlock = output.finishBlock()
    if (decodedBlock.byteLength !== originalLength) {
      throw lz4Error('decode', 'decoded block length does not match the header', offset - compressedLength)
    }
    if (xxHash32(decodedBlock, LZ4_DEFAULT_SEED) !== checksum) {
      throw lz4Error('decode', 'block checksum does not match', offset - compressedLength - LZ4_BLOCK_HEADER_BYTES + 17)
    }
  }

  if (offset !== input.byteLength) throw lz4Error('decode', 'trailing bytes follow the block stream', offset)
  return output.toUint8Array()
}
