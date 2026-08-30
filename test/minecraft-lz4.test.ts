/* oxlint-disable no-bitwise -- test fixtures construct exact Minecraft LZ4 block fields. */

import { describe, expect, it } from 'vitest'
import { decodeLz4BlockStream, encodeLz4BlockStream, MinecraftLz4Error } from '../src/domain/minecraft-lz4.js'

const MAGIC = Uint8Array.from([0x4c, 0x5a, 0x34, 0x42, 0x6c, 0x6f, 0x63, 0x6b])
const DEFAULT_LEVEL = 6
const RAW_METHOD = 0x10
const LZ4_METHOD = 0x20
const DEFAULT_SEED = 0x9747b28c
const PRIME_1 = 0x9e3779b1
const PRIME_2 = 0x85ebca77
const PRIME_3 = 0xc2b2ae3d
const PRIME_4 = 0x27d4eb2f
const PRIME_5 = 0x165667b1

const JAVA_LZ4_RAW_FIXTURE = Uint8Array.from([
  ...MAGIC,
  RAW_METHOD | DEFAULT_LEVEL,
  3,
  0,
  0,
  0,
  3,
  0,
  0,
  0,
  0x36,
  0xb0,
  0x75,
  0xce,
  1,
  2,
  3,
  ...MAGIC,
  RAW_METHOD | DEFAULT_LEVEL,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
])

const rotateLeft = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits))

// `noUncheckedIndexedAccess` types every Uint8Array index read as `number | undefined`. These fixture
// helpers only ever index within bounds they just computed, so an out-of-range read is a bug in the
// helper itself, not an input to validate — hence a throw rather than a guard clause the caller reacts to.
const byteAt = (bytes: Uint8Array, index: number): number => {
  const value = bytes[index]
  if (value === undefined) throw new Error(`byte index ${index} out of range (length ${bytes.length})`)
  return value
}

const readUint32LittleEndian = (bytes: Uint8Array, offset: number): number =>
  (byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8) | (byteAt(bytes, offset + 2) << 16) | (byteAt(bytes, offset + 3) << 24)) >>>
  0

const appendUint32LittleEndian = (bytes: number[], value: number): void => {
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

const xxHashRound = (accumulator: number, input: number): number =>
  Math.imul(rotateLeft((accumulator + Math.imul(input, PRIME_2)) >>> 0, 13), PRIME_1) >>> 0

const xxHash32 = (bytes: Uint8Array, seed = DEFAULT_SEED): number => {
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
    accumulator = (accumulator + Math.imul(byteAt(bytes, offset), PRIME_5)) >>> 0
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

type BlockFixture = {
  readonly encoded: Uint8Array
  readonly decoded: Uint8Array
  readonly method?: number
  readonly level?: number
  readonly checksum?: number
}

const makeBlockStream = (blocks: readonly BlockFixture[]): Uint8Array => {
  const bytes: number[] = []
  for (const block of blocks) {
    bytes.push(...MAGIC, (block.method ?? RAW_METHOD) | (block.level ?? DEFAULT_LEVEL))
    appendUint32LittleEndian(bytes, block.encoded.byteLength)
    appendUint32LittleEndian(bytes, block.decoded.byteLength)
    appendUint32LittleEndian(bytes, block.checksum ?? xxHash32(block.decoded))
    bytes.push(...block.encoded)
  }
  bytes.push(...MAGIC, RAW_METHOD | DEFAULT_LEVEL)
  appendUint32LittleEndian(bytes, 0)
  appendUint32LittleEndian(bytes, 0)
  appendUint32LittleEndian(bytes, 0)
  return Uint8Array.from(bytes)
}

const replaceByte = (bytes: Uint8Array, offset: number, value: number): Uint8Array => {
  const result = bytes.slice()
  result[offset] = value
  return result
}

const replaceUint32 = (bytes: Uint8Array, offset: number, value: number): Uint8Array => {
  const result = bytes.slice()
  result[offset] = value & 0xff
  result[offset + 1] = (value >>> 8) & 0xff
  result[offset + 2] = (value >>> 16) & 0xff
  result[offset + 3] = (value >>> 24) & 0xff
  return result
}

const expectLz4Error = (operation: () => unknown): void => {
  expect(operation).toThrowError(MinecraftLz4Error)
}

// Widens a value's static type to `T` with NO runtime transformation (no clone, no serialization) and
// no type assertion: `Record<string, any>` indexing is `any` by construction, which is assignable
// anywhere with zero compiler complaint. Used only to hand a deliberately type-invalid value (the kind
// that arrives from disk/network with no static type at all) to a strictly-typed function, so the test
// proves the function's own runtime check rejects it rather than relying on TypeScript to reject it.
const widen = <T,>(value: unknown): T => {
  const bag: Record<string, any> = {}
  bag['value'] = value
  return bag['value']
}

describe('Minecraft LZ4 block stream codec', () => {
  it('round-trips empty, literal, repetitive, trailing, and multi-block data', () => {
    const trailingLiterals = Uint8Array.from([
      ...new Uint8Array(32).fill(7),
      ...Array.from({ length: 16 }, (_, index) => index + 100),
    ])
    const inputs = [
      new Uint8Array(),
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6]),
      new Uint8Array(10_000).fill(7),
      Uint8Array.from({ length: 100_000 }, (_, index) => (index * 31 + Math.floor(index / 257)) & 0xff),
      trailingLiterals,
    ]
    for (const input of inputs) expect(decodeLz4BlockStream(encodeLz4BlockStream(input))).toStrictEqual(input)
  })

  it('writes the Minecraft block magic, seeded checksum, raw fallback, and compressed blocks', () => {
    const literal = Uint8Array.from([1, 2, 3])
    const rawStream = encodeLz4BlockStream(literal)
    expect(rawStream.slice(0, 8)).toStrictEqual(MAGIC)
    expect(rawStream[8]).toBe(RAW_METHOD | DEFAULT_LEVEL)
    expect(readUint32LittleEndian(rawStream, 9)).toBe(literal.byteLength)
    expect(readUint32LittleEndian(rawStream, 13)).toBe(literal.byteLength)
    expect(readUint32LittleEndian(rawStream, 17)).toBe(xxHash32(literal))

    const repetitive = encodeLz4BlockStream(new Uint8Array(10_000).fill(7))
    expect(byteAt(repetitive, 8) & 0xf0).toBe(LZ4_METHOD)
    expect(readUint32LittleEndian(repetitive, 9)).toBeLessThan(readUint32LittleEndian(repetitive, 13))
  })

  it('matches a fixed Java LZ4 raw block-stream fixture in both directions', () => {
    const literal = Uint8Array.from([1, 2, 3])
    expect(encodeLz4BlockStream(literal)).toStrictEqual(JAVA_LZ4_RAW_FIXTURE)
    expect(decodeLz4BlockStream(JAVA_LZ4_RAW_FIXTURE)).toStrictEqual(literal)
  })

  it('formats errors with and without byte offsets', () => {
    expect(new MinecraftLz4Error({ operation: 'encode', reason: 'bad input' }).message).toBe(
      'Minecraft LZ4 encode failed: bad input',
    )
    expect(new MinecraftLz4Error({ operation: 'decode', reason: 'bad block', offset: 12 }).message).toBe(
      'Minecraft LZ4 decode failed at byte offset 12: bad block',
    )
  })

  it('decodes compressed overlapping matches, raw blocks, custom levels, and the terminator', () => {
    const match = Uint8Array.from([0x10, 1, 1, 0])
    const repeated = new Uint8Array(5).fill(1)
    const literal = Uint8Array.from([0, 1, 2, 3, 4, 5])
    const stream = makeBlockStream([
      { encoded: match, decoded: repeated, method: LZ4_METHOD },
      { encoded: literal, decoded: literal, level: 0 },
    ])
    expect(decodeLz4BlockStream(stream)).toStrictEqual(Uint8Array.from([...repeated, ...literal]))
    expect(decodeLz4BlockStream(makeBlockStream([]))).toStrictEqual(new Uint8Array())
  })

  it('accepts long literal and match length extensions', () => {
    const literal = Uint8Array.from({ length: 270 }, (_, index) => index & 0xff)
    const literalBlock = Uint8Array.from([0xf0, 255, 0, ...literal])
    expect(decodeLz4BlockStream(makeBlockStream([{ encoded: literalBlock, decoded: literal, method: LZ4_METHOD }]))).toStrictEqual(literal)

    const matchBlock = Uint8Array.from([0x1f, 1, 1, 0, 255, 0])
    const repeated = new Uint8Array(275).fill(1)
    expect(decodeLz4BlockStream(makeBlockStream([{ encoded: matchBlock, decoded: repeated, method: LZ4_METHOD }]))).toStrictEqual(repeated)
  })

  it('enforces input, output, and block limits', () => {
    expectLz4Error(() => encodeLz4BlockStream(new Uint8Array(2), { maxBytes: 1 }))
    expectLz4Error(() => decodeLz4BlockStream(encodeLz4BlockStream(new Uint8Array(2)), { maxBytes: 1 }))
    const twoBlocks = makeBlockStream([
      { encoded: Uint8Array.from([1, 2]), decoded: Uint8Array.from([1, 2]) },
      { encoded: Uint8Array.from([3, 4]), decoded: Uint8Array.from([3, 4]) },
    ])
    expectLz4Error(() => decodeLz4BlockStream(twoBlocks, { maxBytes: 3 }))
    const overproducingBlock = makeBlockStream([
      { encoded: Uint8Array.from([0x10, 1, 1, 0]), decoded: Uint8Array.from([1]), method: LZ4_METHOD },
    ])
    expectLz4Error(() => decodeLz4BlockStream(overproducingBlock, { maxBytes: 1 }))
    expect(decodeLz4BlockStream(makeBlockStream([]), { maxBytes: 0 })).toStrictEqual(new Uint8Array())
    expectLz4Error(() => encodeLz4BlockStream(new Uint8Array(), { maxBytes: -1 }))
    expectLz4Error(() => decodeLz4BlockStream(new Uint8Array(), { maxBytes: Number.NaN }))
    expectLz4Error(() => encodeLz4BlockStream(widen(null)))
    expectLz4Error(() => decodeLz4BlockStream(widen(null)))
  })

  it('rejects invalid block headers and metadata', () => {
    const valid = makeBlockStream([{ encoded: Uint8Array.from([1, 2, 3]), decoded: Uint8Array.from([1, 2, 3]) }])
    expectLz4Error(() => decodeLz4BlockStream(new Uint8Array(20)))
    expectLz4Error(() => decodeLz4BlockStream(replaceByte(valid, 0, 0)))
    expectLz4Error(() => decodeLz4BlockStream(replaceByte(valid, 8, 0x36)))
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(valid, 9, 0xffffffff)))
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(valid, 13, 0xffffffff)))
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(valid, 9, 0)))
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(valid, 13, 0)))
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(valid, 9, 2)))
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(replaceByte(valid, 8, LZ4_METHOD), 13, 2048)))
    expectLz4Error(() => decodeLz4BlockStream(replaceByte(valid, 20, byteAt(valid, 20) ^ 1)))
    expectLz4Error(() => decodeLz4BlockStream(Uint8Array.from([...valid, 1])))

    const invalidTerminator = valid.slice(valid.length - 21)
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(invalidTerminator, 17, 1)))
  })

  it('rejects malformed compressed blocks and truncation', () => {
    const fixture = (encoded: number[], decodedLength = 1): Uint8Array =>
      makeBlockStream([{ encoded: Uint8Array.from(encoded), decoded: new Uint8Array(decodedLength), method: LZ4_METHOD }])
    expectLz4Error(() => decodeLz4BlockStream(fixture([0xf0])))
    expectLz4Error(() => decodeLz4BlockStream(fixture([0x50, 1])))
    expectLz4Error(() => decodeLz4BlockStream(fixture([0x00, 1])))
    expectLz4Error(() => decodeLz4BlockStream(fixture([0x00, 0, 0])))
    expectLz4Error(() => decodeLz4BlockStream(fixture([0x00, 1, 0])))
    expectLz4Error(() => decodeLz4BlockStream(fixture([0x10, 1, 1, 0], 4)))

    const raw = makeBlockStream([{ encoded: Uint8Array.from([1, 2, 3]), decoded: Uint8Array.from([1, 2, 3]) }])
    expectLz4Error(() => decodeLz4BlockStream(raw.slice(0, 20)))
    expectLz4Error(() => decodeLz4BlockStream(raw.slice(0, 21 + 2)))
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(raw, 9, 4)))
    expectLz4Error(() => decodeLz4BlockStream(replaceUint32(raw, 13, 2)))
  })

  it('rejects invalid checksums and checksum truncation', () => {
    const input = Uint8Array.from([1, 2, 3, 4, 5])
    const valid = encodeLz4BlockStream(input)
    expectLz4Error(() => decodeLz4BlockStream(replaceByte(valid, 17, byteAt(valid, 17) ^ 1)))
    expectLz4Error(() => decodeLz4BlockStream(valid.slice(0, valid.length - 1)))
    const badBlockChecksum = makeBlockStream([{ encoded: input, decoded: input, checksum: xxHash32(input) ^ 1 }])
    expectLz4Error(() => decodeLz4BlockStream(badBlockChecksum))
  })
})
