/* oxlint-disable no-bitwise -- LZ4 block fields are bit-packed by the format. */

import {
  assertInput,
  ByteWriter,
  LZ4_BLOCK_MAGIC,
  LZ4_BLOCK_SIZE,
  LZ4_COMPRESSION_LEVEL,
  LZ4_COMPRESSION_METHOD_LZ4,
  LZ4_COMPRESSION_METHOD_RAW,
  LZ4_DEFAULT_SEED,
  LZ4_HASH_SIZE,
  LZ4_LAST_LITERALS,
  LZ4_MATCH_FIND_LIMIT,
  LZ4_MAX_OFFSET,
  lz4Error,
  readUint32LittleEndian,
  resolveMaxBytes,
  writeLength,
  xxHash32,
} from './minecraft-lz4-format.js'
import type { MinecraftLz4Options } from './minecraft-lz4-format.js'
import { assertDefined } from './assert-defined.js'

const hashSequence = (bytes: Uint8Array, offset: number): number =>
  (Math.imul(readUint32LittleEndian(bytes, offset), 2654435761) >>> 0) >>> 16

const equalFourBytes = (bytes: Uint8Array, left: number, right: number): boolean =>
  bytes[left] === bytes[right] &&
  bytes[left + 1] === bytes[right + 1] &&
  bytes[left + 2] === bytes[right + 2] &&
  bytes[left + 3] === bytes[right + 3]

const encodeLz4Block = (input: Uint8Array): Uint8Array => {
  const writer = new ByteWriter()
  const table = new Int32Array(LZ4_HASH_SIZE)
  table.fill(-1)
  const matchFindLimit = input.byteLength - LZ4_MATCH_FIND_LIMIT
  const matchLimit = input.byteLength - LZ4_LAST_LITERALS
  let anchor = 0
  let offset = 0

  while (offset <= matchFindLimit) {
    const hash = hashSequence(input, offset)
    const candidate = assertDefined(table[hash], `encodeLz4Block: hash ${String(hash)} is out of the table's range`)
    table[hash] = offset
    if (candidate < 0 || offset - candidate > LZ4_MAX_OFFSET || !equalFourBytes(input, candidate, offset)) {
      offset += 1
      continue
    }

    let matchLength = 4
    while (
      offset + matchLength < matchLimit &&
      candidate + matchLength < offset &&
      input[candidate + matchLength] === input[offset + matchLength]
    ) {
      matchLength += 1
    }
    while (offset + matchLength < matchLimit && input[candidate + matchLength] === input[offset + matchLength]) {
      matchLength += 1
    }

    const literalLength = offset - anchor
    const literalToken = Math.min(literalLength, 15)
    const matchToken = Math.min(matchLength - 4, 15)
    writer.writeByte((literalToken << 4) | matchToken)
    if (literalLength >= 15) writeLength(writer, literalLength - 15)
    writer.writeBytes(input.slice(anchor, offset))
    writer.writeByte((offset - candidate) & 0xff)
    writer.writeByte((offset - candidate) >>> 8)
    if (matchLength - 4 >= 15) writeLength(writer, matchLength - 4 - 15)

    offset += matchLength
    anchor = offset
  }

  const literalLength = input.byteLength - anchor
  writer.writeByte(Math.min(literalLength, 15) << 4)
  if (literalLength >= 15) writeLength(writer, literalLength - 15)
  writer.writeBytes(input.slice(anchor))
  return writer.toUint8Array()
}

const writeBlockHeader = (
  writer: ByteWriter,
  method: number,
  compressedLength: number,
  originalLength: number,
  checksum: number,
): void => {
  writer.writeBytes(LZ4_BLOCK_MAGIC)
  writer.writeByte(method | LZ4_COMPRESSION_LEVEL)
  writer.writeUint32LittleEndian(compressedLength)
  writer.writeUint32LittleEndian(originalLength)
  writer.writeUint32LittleEndian(checksum)
}

export const encodeLz4BlockStream = (input: Uint8Array, options?: MinecraftLz4Options): Uint8Array => {
  const maxBytes = resolveMaxBytes('encode', options?.maxBytes)
  assertInput('encode', input)
  if (input.byteLength > maxBytes) throw lz4Error('encode', `input exceeds maxBytes ${String(maxBytes)}`)

  const writer = new ByteWriter()
  for (let offset = 0; offset < input.byteLength; offset += LZ4_BLOCK_SIZE) {
    const block = input.slice(offset, Math.min(input.byteLength, offset + LZ4_BLOCK_SIZE))
    const compressed = encodeLz4Block(block)
    const useCompressed = compressed.byteLength < block.byteLength
    writeBlockHeader(
      writer,
      useCompressed ? LZ4_COMPRESSION_METHOD_LZ4 : LZ4_COMPRESSION_METHOD_RAW,
      useCompressed ? compressed.byteLength : block.byteLength,
      block.byteLength,
      xxHash32(block, LZ4_DEFAULT_SEED),
    )
    writer.writeBytes(useCompressed ? compressed : block)
  }
  writeBlockHeader(writer, LZ4_COMPRESSION_METHOD_RAW, 0, 0, 0)
  return writer.toUint8Array()
}
