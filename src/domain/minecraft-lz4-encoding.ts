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
import type { MinecraftLz4Options, MinecraftLz4Error } from './minecraft-lz4-format.js'
import { Result } from 'effect'
import { assertDefined } from './assert-defined.js'
import { ValidationMessage } from './brand-types.js'

const writeByte = (writer: ByteWriter, value: unknown): Result.Result<void, MinecraftLz4Error> =>
  writer.writeByte(value)

const writeWord = (writer: ByteWriter, value: unknown): Result.Result<void, MinecraftLz4Error> =>
  writer.writeUint32LittleEndian(value)

const hashSequence = (bytes: Uint8Array, offset: number): Result.Result<number, MinecraftLz4Error> =>
  Result.map(readUint32LittleEndian(bytes, offset), (value) => (Math.imul(value, 2654435761) >>> 0) >>> 16)

const equalFourBytes = (bytes: Uint8Array, left: number, right: number): boolean =>
  bytes[left] === bytes[right] &&
  bytes[left + 1] === bytes[right + 1] &&
  bytes[left + 2] === bytes[right + 2] &&
  bytes[left + 3] === bytes[right + 3]

const encodeLz4Block = (input: Uint8Array): Result.Result<Uint8Array, MinecraftLz4Error> =>
  Result.gen(function* () {
    const writer = new ByteWriter()
    const table = new Int32Array(LZ4_HASH_SIZE)
    table.fill(-1)
    const matchFindLimit = input.byteLength - LZ4_MATCH_FIND_LIMIT
    const matchLimit = input.byteLength - LZ4_LAST_LITERALS
    let anchor = 0
    let offset = 0

    while (offset <= matchFindLimit) {
      const hash = yield* hashSequence(input, offset)
      const candidate = yield* assertDefined(table[hash], ValidationMessage('LZ4 hash table index was in range')).pipe(
        Result.mapError(lz4Error.bind(undefined, 'encode')),
      )
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
      yield* writeByte(writer, (literalToken << 4) | matchToken)
      if (literalLength >= 15) yield* writeLength(writer, literalLength - 15)
      writer.writeBytes(input.slice(anchor, offset))
      yield* writeByte(writer, (offset - candidate) & 0xff)
      yield* writeByte(writer, (offset - candidate) >>> 8)
      if (matchLength - 4 >= 15) yield* writeLength(writer, matchLength - 4 - 15)

      offset += matchLength
      anchor = offset
    }

    const literalLength = input.byteLength - anchor
    yield* writeByte(writer, Math.min(literalLength, 15) << 4)
    if (literalLength >= 15) yield* writeLength(writer, literalLength - 15)
    writer.writeBytes(input.slice(anchor))
    return writer.toUint8Array()
  })

const writeBlockHeader = (
  writer: ByteWriter,
  method: number,
  compressedLength: number,
  originalLength: number,
  checksum: number,
): Result.Result<void, MinecraftLz4Error> =>
  Result.gen(function* () {
    writer.writeBytes(LZ4_BLOCK_MAGIC)
    yield* writeByte(writer, method | LZ4_COMPRESSION_LEVEL)
    yield* writeWord(writer, compressedLength)
    yield* writeWord(writer, originalLength)
    yield* writeWord(writer, checksum)
  })

export const encodeLz4BlockStream = (input: Uint8Array, options?: MinecraftLz4Options): Result.Result<Uint8Array, MinecraftLz4Error> =>
  Result.gen(function* () {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Result.fail(lz4Error('encode', 'options.maxBytes could not be read'))
    }
    const maxBytesOption = yield* Result.try({
      try: () => options === undefined ? undefined : Reflect.get(options, 'maxBytes'),
      catch: () => lz4Error('encode', 'options.maxBytes could not be read'),
    })
    const maxBytes = yield* resolveMaxBytes('encode', maxBytesOption)
    yield* assertInput('encode', input)
    if (input.byteLength > maxBytes) return yield* Result.fail(lz4Error('encode', `input exceeds maxBytes ${String(maxBytes)}`))

    const writer = new ByteWriter()
    for (let offset = 0; offset < input.byteLength; offset += LZ4_BLOCK_SIZE) {
      const block = input.slice(offset, Math.min(input.byteLength, offset + LZ4_BLOCK_SIZE))
      const compressed = yield* encodeLz4Block(block)
      const useCompressed = compressed.byteLength < block.byteLength
      const checksum = yield* xxHash32(block, LZ4_DEFAULT_SEED)
      yield* writeBlockHeader(
        writer,
        useCompressed ? LZ4_COMPRESSION_METHOD_LZ4 : LZ4_COMPRESSION_METHOD_RAW,
        useCompressed ? compressed.byteLength : block.byteLength,
        block.byteLength,
        checksum,
      )
      writer.writeBytes(useCompressed ? compressed : block)
    }
    yield* writeBlockHeader(writer, LZ4_COMPRESSION_METHOD_RAW, 0, 0, 0)
    return writer.toUint8Array()
  })
