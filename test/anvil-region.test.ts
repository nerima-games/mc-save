/* oxlint-disable no-bitwise -- test fixtures construct exact three-byte headers. */

import { describe, expect, it } from 'vitest'
import {
  ANVIL_CHUNK_COUNT,
  ANVIL_COMPRESSION_IDS,
  ANVIL_EXTERNAL_CHUNK_THRESHOLD,
  ANVIL_EXTERNAL_FILE_EXTENSION,
  ANVIL_EXTERNAL_STREAM_FLAG,
  ANVIL_HEADER_BYTES,
  ANVIL_MAX_REGION_BYTES,
  ANVIL_SECTOR_BYTES,
  type AnvilCompression,
  type AnvilChunkRecord,
  AnvilRegionError,
  anvilCompressionFromId,
  anvilCompressionId,
  anvilRegion,
  decodeAnvilRegion,
  encodeAnvilRegion,
} from '../src/domain/anvil-region.js'

const emptySlots = (): Array<null> => new Array(ANVIL_CHUNK_COUNT).fill(null)

const timestamps = (value = 0): number[] => new Array(ANVIL_CHUNK_COUNT).fill(value)

const slotsWith = (index: number, chunk: unknown): Array<AnvilChunkRecord | null> => {
  const slots: Array<AnvilChunkRecord | null> = emptySlots()
  // @ts-expect-error -- chunk is deliberately unknown/possibly-invalid, to build negative-test fixtures
  slots[index] = chunk
  return slots
}

const chunkAt = (
  index: number,
  payload = new Uint8Array([1, 2, 3]),
  compression: AnvilCompression = 'none',
  timestamp = 7,
) => ({
  localX: index % 32,
  localZ: Math.floor(index / 32),
  timestamp,
  compression,
  payload,
})

const writeLocation = (bytes: Uint8Array, index: number, sectorOffset: number, sectorLength: number): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = index * 4
  view.setUint8(offset, (sectorOffset >> 16) & 0xff)
  view.setUint8(offset + 1, (sectorOffset >> 8) & 0xff)
  view.setUint8(offset + 2, sectorOffset & 0xff)
  view.setUint8(offset + 3, sectorLength)
}

const writeTimestamp = (bytes: Uint8Array, index: number, timestamp: number): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(ANVIL_SECTOR_BYTES + index * 4, timestamp, false)
}

const writeRecord = (
  bytes: Uint8Array,
  sectorOffset: number,
  recordLength: number,
  compressionId: number,
  payload: ReadonlyArray<number> = [],
): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = sectorOffset * ANVIL_SECTOR_BYTES
  view.setUint32(offset, recordLength, false)
  view.setUint8(offset + 4, compressionId)
  bytes.set(payload, offset + 5)
}

const malformedRegion = (): Uint8Array => new Uint8Array(3 * ANVIL_SECTOR_BYTES)

const expectAnvilError = (operation: () => unknown): void => {
  expect(operation).toThrowError(AnvilRegionError)
}

describe('Minecraft Anvil region codec', () => {
  it('encodes and decodes an empty region with its timestamps', () => {
    const original = anvilRegion(emptySlots(), timestamps(0x10203040))
    const encoded = encodeAnvilRegion(original)

    expect(encoded.byteLength).toBe(ANVIL_HEADER_BYTES)
    expect(decodeAnvilRegion(encoded)).toStrictEqual(original)
  })

  it.each(['gzip', 'zlib', 'none', 'lz4', 'custom'] as const)('round-trips a %s chunk record', (compression) => {
    const index = 33
    const payload = new Uint8Array(ANVIL_SECTOR_BYTES - 4).fill(9)
    const original = anvilRegion(slotsWith(index, chunkAt(index, payload, compression, 11)), timestamps())
    const encoded = encodeAnvilRegion(original)
    const view = new DataView(encoded.buffer)

    expect(view.getUint8(index * 4 + 2)).toBe(2)
    expect(view.getUint8(index * 4 + 3)).toBe(2)
    expect(encoded.byteLength).toBe(4 * ANVIL_SECTOR_BYTES)
    expect(decodeAnvilRegion(encoded)).toStrictEqual(original)
  })

  it('encodes external chunk stubs and maps compression identifiers', () => {
    const index = 65
    const original = anvilRegion(
      slotsWith(index, { ...chunkAt(index, new Uint8Array(), 'lz4', 12), external: true }),
      timestamps(),
    )
    const encoded = encodeAnvilRegion(original)
    const view = new DataView(encoded.buffer)
    const locationOffset = index * 4
    const recordOffset = 2 * ANVIL_SECTOR_BYTES

    expect(view.getUint8(locationOffset + 2)).toBe(2)
    expect(view.getUint8(locationOffset + 3)).toBe(1)
    expect(view.getUint32(recordOffset, false)).toBe(1)
    expect(view.getUint8(recordOffset + 4)).toBe(ANVIL_EXTERNAL_STREAM_FLAG | ANVIL_COMPRESSION_IDS.lz4)
    expect(decodeAnvilRegion(encoded)).toStrictEqual(original)

    expect(anvilCompressionId('gzip')).toBe(ANVIL_COMPRESSION_IDS.gzip)
    expect(anvilCompressionId('zlib')).toBe(ANVIL_COMPRESSION_IDS.zlib)
    expect(anvilCompressionId('none')).toBe(ANVIL_COMPRESSION_IDS.none)
    expect(anvilCompressionId('lz4')).toBe(ANVIL_COMPRESSION_IDS.lz4)
    expect(anvilCompressionId('custom')).toBe(ANVIL_COMPRESSION_IDS.custom)
    expect(anvilCompressionFromId(ANVIL_COMPRESSION_IDS.gzip)).toBe('gzip')
    expect(anvilCompressionFromId(ANVIL_COMPRESSION_IDS.zlib)).toBe('zlib')
    expect(anvilCompressionFromId(ANVIL_COMPRESSION_IDS.none)).toBe('none')
    expect(anvilCompressionFromId(ANVIL_COMPRESSION_IDS.lz4)).toBe('lz4')
    expect(anvilCompressionFromId(ANVIL_COMPRESSION_IDS.custom)).toBe('custom')
    expect(anvilCompressionFromId(0)).toBeUndefined()
    expect(anvilCompressionFromId(99)).toBeUndefined()
    expect(ANVIL_EXTERNAL_CHUNK_THRESHOLD).toBe(256)
    expect(ANVIL_EXTERNAL_FILE_EXTENSION).toBe('.mcc')
  })

  it('preserves custom compression payloads and external custom stubs', () => {
    const customPayload = new Uint8Array([0, 12, 110, 101, 114, 105, 109, 97, 58, 108, 122, 52, 0, 1, 2])
    const inline = anvilRegion(slotsWith(0, chunkAt(0, customPayload, 'custom', 4)), timestamps())
    const inlineBytes = encodeAnvilRegion(inline)
    const inlineView = new DataView(inlineBytes.buffer)

    expect(inlineView.getUint8(2 * ANVIL_SECTOR_BYTES + 4)).toBe(ANVIL_COMPRESSION_IDS.custom)
    expect(decodeAnvilRegion(inlineBytes)).toStrictEqual(inline)

    const external = anvilRegion(
      slotsWith(0, { ...chunkAt(0, new Uint8Array(), 'custom', 5), external: true }),
      timestamps(),
    )
    const externalBytes = encodeAnvilRegion(external)
    const externalView = new DataView(externalBytes.buffer)

    expect(externalView.getUint8(2 * ANVIL_SECTOR_BYTES + 4)).toBe(0xff)
    expect(decodeAnvilRegion(externalBytes)).toStrictEqual(external)
  })

  it('normalizes null slots, overrides timestamps, and copies payloads', () => {
    const payload = new Uint8Array([4, 5, 6])
    const original = anvilRegion(slotsWith(0, chunkAt(0, payload, 'none', 1)), timestamps(2))
    payload[0] = 99
    const fallbackTimestampRegion = anvilRegion(slotsWith(0, chunkAt(0, new Uint8Array([1]), 'none', 7)))

    expect(original.timestamps[0]).toBe(2)
    expect(original.chunks[0]).toMatchObject({ timestamp: 2, payload: new Uint8Array([4, 5, 6]) })
    expect(original.chunks[1]).toBeNull()
    expect(fallbackTimestampRegion.timestamps[0]).toBe(7)
    expect(anvilRegion(emptySlots()).timestamps.every((value) => value === 0)).toBe(true)
  })

  it('formats errors with and without byte offsets', () => {
    expect(new AnvilRegionError({ reason: 'header' }).message).toBe('Anvil region is invalid: header')
    expect(new AnvilRegionError({ reason: 'record', offset: 4 }).message).toBe(
      'Anvil region is invalid at byte offset 4: record',
    )
  })

  it('validates region factories and encoded-region input', () => {
    const valid = chunkAt(0)

    expect(() => {
      // @ts-expect-error -- deliberately not a valid chunks argument
      anvilRegion(null)
    }).toThrowError(AnvilRegionError)
    expect(() => {
      // @ts-expect-error -- deliberately not a valid timestamps argument
      anvilRegion(emptySlots(), null)
    }).toThrowError(AnvilRegionError)
    expect(() => anvilRegion(new Array(1).fill(null))).toThrowError(AnvilRegionError)
    expect(() => anvilRegion(emptySlots(), new Array(1).fill(0))).toThrowError(AnvilRegionError)
    expectAnvilError(() => anvilRegion(slotsWith(0, null), timestamps(-1)))
    expectAnvilError(() => anvilRegion(slotsWith(0, 1), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, localX: -1 }), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, localX: 1.5 }), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, localZ: 32 }), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, timestamp: -1 }), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, timestamp: 0x100000000 }), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, compression: 'bad' }), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, payload: [1] }), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, external: 'yes' }), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(1, valid), timestamps()))
    expectAnvilError(() => anvilRegion(slotsWith(0, { ...valid, payload: new Uint8Array(255 * ANVIL_SECTOR_BYTES - 4) }), timestamps()))

    expectAnvilError(() => {
      // @ts-expect-error -- deliberately not a valid AnvilRegion argument
      encodeAnvilRegion(null)
    })
    expectAnvilError(() => {
      // @ts-expect-error -- deliberately not a valid AnvilRegion argument
      encodeAnvilRegion({ chunks: null, timestamps: [] })
    })
    // The four cases below structurally satisfy AnvilRegion's element types
    // (empty/oversized arrays and slotsWith's declared return type all
    // type-check), so no directive is needed — encodeAnvilRegion rejects them
    // only at runtime, on length and per-chunk invariants a type cannot express.
    expectAnvilError(() => encodeAnvilRegion({ chunks: emptySlots(), timestamps: [] }))
    expectAnvilError(() => encodeAnvilRegion({ chunks: new Array(1).fill(null), timestamps: timestamps() }))
    expectAnvilError(() =>
      encodeAnvilRegion({ chunks: emptySlots(), timestamps: new Array(ANVIL_CHUNK_COUNT).fill(undefined) }),
    )
    expectAnvilError(() => encodeAnvilRegion({ chunks: slotsWith(0, 1), timestamps: timestamps() }))
    expectAnvilError(() =>
      encodeAnvilRegion({ chunks: slotsWith(0, { ...valid, localX: 1 }), timestamps: timestamps() }),
    )
    expectAnvilError(() =>
      encodeAnvilRegion(
        anvilRegion(slotsWith(0, { ...valid, external: true, payload: new Uint8Array([1]) }), timestamps()),
      ),
    )
    expectAnvilError(() => encodeAnvilRegion(anvilRegion(emptySlots()), { maxBytes: ANVIL_HEADER_BYTES - 1 }))
    expectAnvilError(() => encodeAnvilRegion(anvilRegion(emptySlots()), { maxBytes: ANVIL_MAX_REGION_BYTES + 1 }))
    expectAnvilError(() => encodeAnvilRegion(anvilRegion(slotsWith(0, valid), timestamps()), { maxBytes: ANVIL_HEADER_BYTES }))
  })

  it('rejects invalid binary region boundaries and allocations', () => {
    expectAnvilError(() => {
      // @ts-expect-error -- deliberately not a valid decodeAnvilRegion argument
      decodeAnvilRegion(null)
    })
    expectAnvilError(() => decodeAnvilRegion(new Uint8Array(ANVIL_HEADER_BYTES - 1)))
    expectAnvilError(() => decodeAnvilRegion(new Uint8Array(ANVIL_HEADER_BYTES + 1)))
    expectAnvilError(() => decodeAnvilRegion(new Uint8Array(3 * ANVIL_SECTOR_BYTES), { maxBytes: ANVIL_HEADER_BYTES }))
    expectAnvilError(() => decodeAnvilRegion(new Uint8Array(ANVIL_HEADER_BYTES), { maxBytes: ANVIL_HEADER_BYTES - 1 }))
    expectAnvilError(() => decodeAnvilRegion(new Uint8Array(ANVIL_HEADER_BYTES), { maxBytes: ANVIL_MAX_REGION_BYTES + 1 }))
    // A typed array backed by a SharedArrayBuffer passes every size/shape check above
    // (it is still `instanceof Uint8Array`) but its `.buffer` is not an `ArrayBuffer`,
    // which `DataView`'s constructor requires.
    expectAnvilError(() => decodeAnvilRegion(new Uint8Array(new SharedArrayBuffer(ANVIL_HEADER_BYTES))))

    const headerOverlap = malformedRegion()
    writeLocation(headerOverlap, 0, 1, 1)
    expectAnvilError(() => decodeAnvilRegion(headerOverlap))

    const zeroLength = malformedRegion()
    writeLocation(zeroLength, 0, 2, 0)
    expectAnvilError(() => decodeAnvilRegion(zeroLength))

    const beyondRegion = malformedRegion()
    writeLocation(beyondRegion, 0, 2, 2)
    expectAnvilError(() => decodeAnvilRegion(beyondRegion))

    const overlapping = malformedRegion()
    writeLocation(overlapping, 0, 2, 1)
    writeLocation(overlapping, 1, 2, 1)
    writeRecord(overlapping, 2, 1, ANVIL_COMPRESSION_IDS.none)
    expectAnvilError(() => decodeAnvilRegion(overlapping))

    const invalidLength = malformedRegion()
    writeLocation(invalidLength, 0, 2, 1)
    writeRecord(invalidLength, 2, 4093, ANVIL_COMPRESSION_IDS.none)
    expectAnvilError(() => decodeAnvilRegion(invalidLength))

    const unknownCompression = malformedRegion()
    writeLocation(unknownCompression, 0, 2, 1)
    writeRecord(unknownCompression, 2, 1, 99)
    expectAnvilError(() => decodeAnvilRegion(unknownCompression))

    const invalidExternalLength = malformedRegion()
    writeLocation(invalidExternalLength, 0, 2, 1)
    writeRecord(invalidExternalLength, 2, 2, ANVIL_EXTERNAL_STREAM_FLAG | ANVIL_COMPRESSION_IDS.none, [1])
    expectAnvilError(() => decodeAnvilRegion(invalidExternalLength))

    const unknownExternalCompression = malformedRegion()
    writeLocation(unknownExternalCompression, 0, 2, 1)
    writeRecord(unknownExternalCompression, 2, 1, ANVIL_EXTERNAL_STREAM_FLAG | 99)
    expectAnvilError(() => decodeAnvilRegion(unknownExternalCompression))
  })

  it('decodes a raw record and preserves its timestamp and payload', () => {
    const bytes = malformedRegion()
    writeLocation(bytes, 31, 2, 1)
    writeTimestamp(bytes, 31, 0xffffffff)
    writeRecord(bytes, 2, 4, ANVIL_COMPRESSION_IDS.zlib, [7, 8, 9])

    const decoded = decodeAnvilRegion(bytes)
    expect(decoded.timestamps[31]).toBe(0xffffffff)
    expect(decoded.chunks[31]).toStrictEqual({
      localX: 31,
      localZ: 0,
      timestamp: 0xffffffff,
      compression: 'zlib',
      payload: new Uint8Array([7, 8, 9]),
    })
  })
})
