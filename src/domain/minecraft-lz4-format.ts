/* oxlint-disable no-bitwise -- LZ4 block fields and xxHash32 are bit-packed by the format. */

import { Brand, Data, Result } from 'effect'
import type * as Cause from 'effect/Cause'
import { ByteValue } from './brand-types.js'

export const LZ4_BLOCK_MAGIC: Uint8Array<ArrayBuffer> = new Uint8Array([0x4c, 0x5a, 0x34, 0x42, 0x6c, 0x6f, 0x63, 0x6b])
export const LZ4_BLOCK_HEADER_BYTES = 21
export const LZ4_BLOCK_SIZE: number = 64 * 1024
export const LZ4_COMPRESSION_LEVEL_BASE = 10
export const LZ4_COMPRESSION_LEVEL = 6
export const LZ4_COMPRESSION_METHOD_RAW = 0x10
export const LZ4_COMPRESSION_METHOD_LZ4 = 0x20
export const LZ4_DEFAULT_SEED = 0x9747b28c
export const LZ4_LAST_LITERALS = 5
export const LZ4_MATCH_FIND_LIMIT = 12
export const LZ4_MAX_OFFSET = 0xffff
export const LZ4_HASH_SIZE: number = 1 << 16
export const LZ4_MAX_OUTPUT_BYTES: number = 64 * 1024 * 1024

export type Lz4ByteOffset = number & Brand.Brand<'Lz4ByteOffset'>
export type Lz4ByteLength = number & Brand.Brand<'Lz4ByteLength'>
export type Lz4ByteLimit = number & Brand.Brand<'Lz4ByteLimit'>
export type Lz4UInt32 = number & Brand.Brand<'Lz4UInt32'>
type Lz4ErrorReason = string & Brand.Brand<'Lz4ErrorReason'>

const toLz4ByteOffset = Brand.make<Lz4ByteOffset>((value) =>
  Number.isSafeInteger(value) && value >= 0 || 'LZ4 byte offset must be a non-negative safe integer',
)
const toLz4ByteLength = Brand.make<Lz4ByteLength>((value) =>
  Number.isSafeInteger(value) && value >= 0 || 'LZ4 byte length must be a non-negative safe integer',
)
const toLz4ByteLimit = Brand.make<Lz4ByteLimit>((value) =>
  Number.isSafeInteger(value) && value >= 0 || 'LZ4 byte limit must be a non-negative safe integer',
)
const toLz4UInt32 = Brand.make<Lz4UInt32>((value) =>
  Number.isInteger(value) && value >= 0 && value <= 0xffffffff || 'value must be an unsigned 32-bit integer',
)
const toLz4ErrorReason = Brand.make<Lz4ErrorReason>(() => true)

const PRIME_1 = 0x9e3779b1
const PRIME_2 = 0x85ebca77
const PRIME_3 = 0xc2b2ae3d
const PRIME_4 = 0x27d4eb2f
const PRIME_5 = 0x165667b1

type MinecraftLz4ErrorFields = {
  readonly operation: 'encode' | 'decode'
  readonly reason: Lz4ErrorReason
  readonly offset?: Lz4ByteOffset
}

const MinecraftLz4ErrorBase: new (
  args: MinecraftLz4ErrorFields,
) => Cause.YieldableError & { readonly _tag: 'MinecraftLz4Error' } & Readonly<MinecraftLz4ErrorFields> =
  Data.TaggedError('MinecraftLz4Error')

export class MinecraftLz4Error extends MinecraftLz4ErrorBase {
  override get message(): string {
    const prefix = `Minecraft LZ4 ${this.operation} failed`
    return this.offset === undefined ? `${prefix}: ${this.reason}` : `${prefix} at byte offset ${String(this.offset)}: ${this.reason}`
  }
}

export type MinecraftLz4Options = {
  readonly maxBytes?: unknown
}

export type Lz4Operation = MinecraftLz4Error['operation']

export const lz4Error = (operation: Lz4Operation, reason: unknown, offset?: unknown): MinecraftLz4Error => {
  const message = typeof reason === 'string' ? reason : String(reason)
  const brandedReason = toLz4ErrorReason(message)
  if (offset === undefined) return new MinecraftLz4Error({ operation, reason: brandedReason })
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    return new MinecraftLz4Error({ operation, reason: toLz4ErrorReason(`${message} (invalid error offset)` ) })
  }
  const brandedOffset = toLz4ByteOffset.result(offset)
  return Result.isSuccess(brandedOffset)
    ? new MinecraftLz4Error({ operation, reason: brandedReason, offset: brandedOffset.success })
    : new MinecraftLz4Error({ operation, reason: toLz4ErrorReason(`${message} (invalid error offset)`) })
}

export const resolveMaxBytes = (operation: Lz4Operation, maxBytes: unknown): Result.Result<Lz4ByteLimit, MinecraftLz4Error> => {
  const resolved = maxBytes === undefined ? LZ4_MAX_OUTPUT_BYTES : maxBytes
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 0) {
    return Result.fail(lz4Error(operation, 'maxBytes must be a non-negative safe integer'))
  }
  return Result.mapError(toLz4ByteLimit.result(resolved), () => lz4Error(operation, 'maxBytes must be a non-negative safe integer'))
}

export const assertInput = (operation: Lz4Operation, input: Uint8Array): Result.Result<void, MinecraftLz4Error> =>
  input instanceof Uint8Array
    ? Result.succeed(undefined)
    : Result.fail(lz4Error(operation, 'input must be a Uint8Array'))

const rotateLeft = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits))

const assertByte = (value: number | undefined, offset: number): Result.Result<number, MinecraftLz4Error> =>
  value === undefined
    ? Result.fail(lz4Error('decode', `readUint32LittleEndian: offset ${String(offset)} is out of range`, offset))
    : Result.succeed(value)

export const readUint32LittleEndian = (bytes: Uint8Array, offset: unknown): Result.Result<Lz4UInt32, MinecraftLz4Error> =>
  Result.gen(function* () {
    if (!(bytes instanceof Uint8Array)) return yield* Result.fail(lz4Error('decode', 'input must be a Uint8Array'))
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      return yield* Result.fail(lz4Error('decode', 'readUint32LittleEndian: offset must be a non-negative safe integer'))
    }
    const checkedOffset = yield* Result.mapError(
      toLz4ByteOffset.result(offset),
      () => lz4Error('decode', 'readUint32LittleEndian: offset must be a non-negative safe integer'),
    )
    const first = yield* assertByte(bytes[checkedOffset], checkedOffset)
    const second = yield* assertByte(bytes[checkedOffset + 1], checkedOffset + 1)
    const third = yield* assertByte(bytes[checkedOffset + 2], checkedOffset + 2)
    const fourth = yield* assertByte(bytes[checkedOffset + 3], checkedOffset + 3)
    const value = (first | (second << 8) | (third << 16) | (fourth << 24)) >>> 0
    return yield* Result.mapError(toLz4UInt32.result(value), () => lz4Error('decode', 'decoded integer is out of range'))
  })

const writeUint32LittleEndian = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

const xxHashRound = (accumulator: number, input: number): number =>
  Math.imul(rotateLeft((accumulator + Math.imul(input, PRIME_2)) >>> 0, 13), PRIME_1) >>> 0

export const xxHash32 = (bytes: Uint8Array, seed: unknown): Result.Result<Lz4UInt32, MinecraftLz4Error> =>
  Result.gen(function* () {
    if (!(bytes instanceof Uint8Array)) return yield* Result.fail(lz4Error('encode', 'input must be a Uint8Array'))
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      return yield* Result.fail(lz4Error('encode', 'seed must be an unsigned 32-bit integer'))
    }
    const checkedSeed = yield* Result.mapError(
      toLz4UInt32.result(seed),
      () => lz4Error('encode', 'seed must be an unsigned 32-bit integer'),
    )
    let offset = 0
    let accumulator: number

    if (bytes.byteLength >= 16) {
      let first = (checkedSeed + PRIME_1 + PRIME_2) >>> 0
      let second = (checkedSeed + PRIME_2) >>> 0
      let third = checkedSeed >>> 0
      let fourth = (checkedSeed - PRIME_1) >>> 0
      const limit = bytes.byteLength - 16
      while (offset <= limit) {
        first = xxHashRound(first, yield* readUint32LittleEndian(bytes, offset))
        second = xxHashRound(second, yield* readUint32LittleEndian(bytes, offset + 4))
        third = xxHashRound(third, yield* readUint32LittleEndian(bytes, offset + 8))
        fourth = xxHashRound(fourth, yield* readUint32LittleEndian(bytes, offset + 12))
        offset += 16
      }
      accumulator = (rotateLeft(first, 1) + rotateLeft(second, 7) + rotateLeft(third, 12) + rotateLeft(fourth, 18)) >>> 0
    } else {
      accumulator = (checkedSeed + PRIME_5) >>> 0
    }

    accumulator = (accumulator + bytes.byteLength) >>> 0
    while (offset + 4 <= bytes.byteLength) {
      accumulator = (accumulator + Math.imul(yield* readUint32LittleEndian(bytes, offset), PRIME_3)) >>> 0
      accumulator = Math.imul(rotateLeft(accumulator, 17), PRIME_4) >>> 0
      offset += 4
    }
    while (offset < bytes.byteLength) {
      const value = yield* assertByte(bytes[offset], offset)
      accumulator = (accumulator + Math.imul(value, PRIME_5)) >>> 0
      accumulator = Math.imul(rotateLeft(accumulator, 11), PRIME_1) >>> 0
      offset += 1
    }

    accumulator ^= accumulator >>> 15
    accumulator = Math.imul(accumulator, PRIME_2) >>> 0
    accumulator ^= accumulator >>> 13
    accumulator = Math.imul(accumulator, PRIME_3) >>> 0
    accumulator ^= accumulator >>> 16
    return yield* Result.mapError(toLz4UInt32.result(accumulator >>> 0), () => lz4Error('encode', 'hash is out of range'))
  })

export class ByteWriter {
  private bytes = new Uint8Array(256)
  private length = 0
  private readonly operation: Lz4Operation

  constructor(operation: Lz4Operation = 'encode') {
    this.operation = operation
  }

  writeByte(value: unknown): Result.Result<void, MinecraftLz4Error> {
    if (typeof value !== 'number') return Result.fail(lz4Error(this.operation, 'byte value must be a number'))
    return Result.map(
      Result.mapError(ByteValue.result(value), (reason) => lz4Error(this.operation, reason)),
      (byte) => {
        this.ensureCapacity(this.length + 1)
        this.bytes[this.length] = byte
        this.length += 1
      },
    )
  }

  writeBytes(input: Uint8Array): void {
    this.ensureCapacity(this.length + input.byteLength)
    this.bytes.set(input, this.length)
    this.length += input.byteLength
  }

  writeUint32LittleEndian(value: unknown): Result.Result<void, MinecraftLz4Error> {
    if (typeof value !== 'number') return Result.fail(lz4Error(this.operation, 'LZ4 word must be a number'))
    return Result.map(
      Result.mapError(toLz4UInt32.result(value), (reason) => lz4Error(this.operation, reason)),
      (word) => {
        this.ensureCapacity(this.length + 4)
        writeUint32LittleEndian(this.bytes, this.length, word)
        this.length += 4
      },
    )
  }

  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.length)
  }

  clear(): void {
    this.bytes = new Uint8Array(256)
    this.length = 0
  }

  private ensureCapacity(required: number): void {
    if (required <= this.bytes.byteLength) return
    let capacity = this.bytes.byteLength
    while (capacity < required) capacity *= 2
    const next = new Uint8Array(capacity)
    next.set(this.bytes)
    this.bytes = next
  }
}

export const writeLength = (
  writer: ByteWriter,
  length: unknown,
): Result.Result<void, MinecraftLz4Error> =>
  Result.gen(function* () {
    if (typeof length !== 'number') {
      return yield* Result.fail(lz4Error('encode', 'LZ4 length must be a non-negative safe integer'))
    }
    let remaining = yield* Result.mapError(
      toLz4ByteLength.result(length),
      () => lz4Error('encode', 'LZ4 length must be a non-negative safe integer'),
    )
    while (remaining >= 255) {
      const byte = yield* Result.mapError(ByteValue.result(255), () => lz4Error('encode', 'invalid LZ4 length byte'))
      yield* writer.writeByte(byte)
      remaining = yield* Result.mapError(
        toLz4ByteLength.result(remaining - 255),
        () => lz4Error('encode', 'LZ4 length must be a non-negative safe integer'),
      )
    }
    const finalByte = yield* Result.mapError(
      ByteValue.result(remaining),
      () => lz4Error('encode', 'invalid LZ4 length byte'),
    )
    yield* writer.writeByte(finalByte)
  })
