/* oxlint-disable no-bitwise -- LZ4 block fields and xxHash32 are bit-packed by the format. */

import { Data } from 'effect'
import { assertDefined } from './assert-defined.js'

export const LZ4_BLOCK_MAGIC = new Uint8Array([0x4c, 0x5a, 0x34, 0x42, 0x6c, 0x6f, 0x63, 0x6b])
export const LZ4_BLOCK_HEADER_BYTES = 21
export const LZ4_BLOCK_SIZE = 64 * 1024
export const LZ4_COMPRESSION_LEVEL_BASE = 10
export const LZ4_COMPRESSION_LEVEL = 6
export const LZ4_COMPRESSION_METHOD_RAW = 0x10
export const LZ4_COMPRESSION_METHOD_LZ4 = 0x20
export const LZ4_DEFAULT_SEED = 0x9747b28c
export const LZ4_LAST_LITERALS = 5
export const LZ4_MATCH_FIND_LIMIT = 12
export const LZ4_MAX_OFFSET = 0xffff
export const LZ4_HASH_SIZE = 1 << 16
export const LZ4_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const PRIME_1 = 0x9e3779b1
const PRIME_2 = 0x85ebca77
const PRIME_3 = 0xc2b2ae3d
const PRIME_4 = 0x27d4eb2f
const PRIME_5 = 0x165667b1

export class MinecraftLz4Error extends Data.TaggedError('MinecraftLz4Error')<{
  readonly operation: 'encode' | 'decode'
  readonly reason: string
  readonly offset?: number
}> {
  override get message(): string {
    const prefix = `Minecraft LZ4 ${this.operation} failed`
    return this.offset === undefined ? `${prefix}: ${this.reason}` : `${prefix} at byte offset ${String(this.offset)}: ${this.reason}`
  }
}

export type MinecraftLz4Options = {
  readonly maxBytes?: number
}

export type Lz4Operation = MinecraftLz4Error['operation']

export const lz4Error = (operation: Lz4Operation, reason: string, offset?: number): MinecraftLz4Error =>
  new MinecraftLz4Error({ operation, reason, ...(offset === undefined ? {} : { offset }) })

export const resolveMaxBytes = (operation: Lz4Operation, maxBytes: number | undefined): number => {
  const resolved = maxBytes ?? LZ4_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw lz4Error(operation, 'maxBytes must be a non-negative safe integer')
  }
  return resolved
}

export const assertInput = (operation: Lz4Operation, input: Uint8Array): void => {
  if (!(input instanceof Uint8Array)) throw lz4Error(operation, 'input must be a Uint8Array')
}

const rotateLeft = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits))

const assertByte = (value: number | undefined, offset: number): number =>
  assertDefined(value, `readUint32LittleEndian: offset ${String(offset)} is out of range`)

export const readUint32LittleEndian = (bytes: Uint8Array, offset: number): number =>
  (assertByte(bytes[offset], offset) |
    (assertByte(bytes[offset + 1], offset + 1) << 8) |
    (assertByte(bytes[offset + 2], offset + 2) << 16) |
    (assertByte(bytes[offset + 3], offset + 3) << 24)) >>>
  0

const writeUint32LittleEndian = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

const xxHashRound = (accumulator: number, input: number): number =>
  Math.imul(rotateLeft((accumulator + Math.imul(input, PRIME_2)) >>> 0, 13), PRIME_1) >>> 0

export const xxHash32 = (bytes: Uint8Array, seed: number): number => {
  let offset = 0
  let accumulator: number

  if (bytes.byteLength >= 16) {
    let first = (seed + PRIME_1 + PRIME_2) >>> 0
    let second = (seed + PRIME_2) >>> 0
    let third = seed >>> 0
    let fourth = (seed - PRIME_1) >>> 0
    const limit = bytes.byteLength - 16
    while (offset <= limit) {
      first = xxHashRound(first, readUint32LittleEndian(bytes, offset))
      second = xxHashRound(second, readUint32LittleEndian(bytes, offset + 4))
      third = xxHashRound(third, readUint32LittleEndian(bytes, offset + 8))
      fourth = xxHashRound(fourth, readUint32LittleEndian(bytes, offset + 12))
      offset += 16
    }
    accumulator = (rotateLeft(first, 1) + rotateLeft(second, 7) + rotateLeft(third, 12) + rotateLeft(fourth, 18)) >>> 0
  } else {
    accumulator = (seed + PRIME_5) >>> 0
  }

  accumulator = (accumulator + bytes.byteLength) >>> 0
  while (offset + 4 <= bytes.byteLength) {
    accumulator = (accumulator + Math.imul(readUint32LittleEndian(bytes, offset), PRIME_3)) >>> 0
    accumulator = Math.imul(rotateLeft(accumulator, 17), PRIME_4) >>> 0
    offset += 4
  }
  while (offset < bytes.byteLength) {
    accumulator = (accumulator + Math.imul(assertByte(bytes[offset], offset), PRIME_5)) >>> 0
    accumulator = Math.imul(rotateLeft(accumulator, 11), PRIME_1) >>> 0
    offset += 1
  }

  accumulator ^= accumulator >>> 15
  accumulator = Math.imul(accumulator, PRIME_2) >>> 0
  accumulator ^= accumulator >>> 13
  accumulator = Math.imul(accumulator, PRIME_3) >>> 0
  accumulator ^= accumulator >>> 16
  return accumulator >>> 0
}

export class ByteWriter {
  private bytes = new Uint8Array(256)
  private length = 0

  writeByte(value: number): void {
    this.ensureCapacity(this.length + 1)
    this.bytes[this.length] = value
    this.length += 1
  }

  writeBytes(input: Uint8Array): void {
    this.ensureCapacity(this.length + input.byteLength)
    this.bytes.set(input, this.length)
    this.length += input.byteLength
  }

  writeUint32LittleEndian(value: number): void {
    this.ensureCapacity(this.length + 4)
    writeUint32LittleEndian(this.bytes, this.length, value)
    this.length += 4
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

export const writeLength = (writer: ByteWriter, length: number): void => {
  let remaining = length
  while (remaining >= 255) {
    writer.writeByte(255)
    remaining -= 255
  }
  writer.writeByte(remaining)
}
