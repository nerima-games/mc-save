import { describe, expect, it } from 'vitest'
import {
  ANVIL_CHUNK_COUNT,
  ANVIL_HEADER_BYTES,
  ANVIL_MAX_CHUNK_SECTORS,
  ANVIL_SECTOR_BYTES,
  type AnvilCompression,
  type AnvilChunkRecord,
  anvilRegion,
  decodeAnvilRegion,
} from '../src/domain/anvil-region.js'
import {
  MinecraftRegionFilesError,
  decodeMinecraftExternalChunkFile,
  decodeMinecraftRegionFiles,
  encodeMinecraftExternalChunkFile,
  encodeMinecraftRegionFiles,
} from '../src/domain/minecraft-region-files.js'

const emptySlots = (): Array<null> => new Array(ANVIL_CHUNK_COUNT).fill(null)

const timestamps = (value = 0): number[] => new Array(ANVIL_CHUNK_COUNT).fill(value)

const slotsWith = (index: number, chunk: AnvilChunkRecord): Array<AnvilChunkRecord | null> => {
  const slots = emptySlots() as Array<AnvilChunkRecord | null>
  slots[index] = chunk
  return slots
}

const chunkAt = (
  index: number,
  payload = new Uint8Array([1, 2, 3]),
  compression: AnvilCompression = 'none',
  timestamp = 7,
): AnvilChunkRecord => ({
  localX: index % 32,
  localZ: Math.floor(index / 32),
  timestamp,
  compression,
  payload,
})

const emptyRegion = (): ReturnType<typeof anvilRegion> => anvilRegion(emptySlots(), timestamps())

const expectRegionFilesError = (operation: () => unknown): void => {
  expect(operation).toThrowError(MinecraftRegionFilesError)
}

describe('Minecraft external region file codec', () => {
  it('encodes and decodes raw compressed .mcc payload bytes', () => {
    const payload = new Uint8Array([4, 5, 6])
    const encoded = encodeMinecraftExternalChunkFile(payload)

    expect(encoded).toStrictEqual(payload)
    encoded[0] = 99
    expect(payload[0]).toBe(4)

    const padded = new Uint8Array(payload.byteLength + 2)
    padded.set(payload, 1)
    const decoded = decodeMinecraftExternalChunkFile(padded.subarray(1, padded.byteLength - 1))

    expect(decoded).toStrictEqual(payload)
    decoded[0] = 99
    expect(payload[0]).toBe(4)
  })

  it('validates external payload inputs and limits', () => {
    const valid = encodeMinecraftExternalChunkFile(new Uint8Array())
    const payload = new Uint8Array([1, 2, 3])
    const validPayloadFile = encodeMinecraftExternalChunkFile(payload)

    expect(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: 3 })).not.toThrow()
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(null as never))
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile([1] as never))
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: 2 }))
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: 8.5 }))
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: -1 }))
    expectRegionFilesError(() =>
      encodeMinecraftExternalChunkFile(payload, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }),
    )
    expect(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: Number.MAX_SAFE_INTEGER })).not.toThrow()

    expectRegionFilesError(() => decodeMinecraftExternalChunkFile(null as never))
    expect(decodeMinecraftExternalChunkFile(valid)).toStrictEqual(new Uint8Array())
    expectRegionFilesError(() => decodeMinecraftExternalChunkFile(validPayloadFile, { maxBytes: 2 }))
    expectRegionFilesError(() => decodeMinecraftExternalChunkFile(validPayloadFile, { maxBytes: -1 }))
  })

  it('writes external stubs and restores their payloads from .mcc files', () => {
    const index = 37
    const source = anvilRegion(
      slotsWith(index, { ...chunkAt(index, new Uint8Array([8, 9]), 'lz4', 12), external: true }),
      timestamps(),
    )
    const files = encodeMinecraftRegionFiles(source, { maxRegionBytes: ANVIL_HEADER_BYTES + ANVIL_SECTOR_BYTES })
    const stub = decodeAnvilRegion(files.region).chunks[index]

    expect(files.externalChunks).toHaveLength(1)
    expect(files.externalChunks[0]).toMatchObject({ localX: 5, localZ: 1 })
    expect(files.externalChunks[0]?.bytes).toStrictEqual(new Uint8Array([8, 9]))
    expect(stub).toMatchObject({ external: true, payload: new Uint8Array() })
    expect(decodeMinecraftRegionFiles(files.region, files.externalChunks, { maxRegionBytes: files.region.byteLength })).toStrictEqual(
      source,
    )
  })

  it('automatically externalizes payloads that exceed the local sector threshold', () => {
    const index = 2
    const payload = new Uint8Array(ANVIL_MAX_CHUNK_SECTORS * ANVIL_SECTOR_BYTES - 4).fill(7)
    const source = { chunks: slotsWith(index, chunkAt(index, payload)), timestamps: timestamps() }
    const files = encodeMinecraftRegionFiles(source)
    const stub = decodeAnvilRegion(files.region).chunks[index]

    expect(files.externalChunks).toHaveLength(1)
    expect(files.externalChunks[0]?.bytes).toStrictEqual(payload)
    expect(stub).toMatchObject({ external: true, payload: new Uint8Array() })
    expect(source.chunks[index]).not.toHaveProperty('external')
  })

  it('rejects invalid region-file relationships and input containers', () => {
    const index = 37
    const externalSource = anvilRegion(
      slotsWith(index, { ...chunkAt(index, new Uint8Array([8]), 'none'), external: true }),
      timestamps(),
    )
    const files = encodeMinecraftRegionFiles(externalSource)
    const externalFile = files.externalChunks[0]!
    const emptyBytes = encodeMinecraftRegionFiles(emptyRegion(), { maxRegionBytes: ANVIL_HEADER_BYTES }).region

    expectRegionFilesError(() => encodeMinecraftRegionFiles(null as never))
    expectRegionFilesError(() => encodeMinecraftRegionFiles({ chunks: null, timestamps: [] } as never))
    expectRegionFilesError(() => decodeMinecraftRegionFiles(emptyBytes, null as never))
    expectRegionFilesError(() => decodeMinecraftRegionFiles(files.region, [null as never]))
    expectRegionFilesError(() =>
      decodeMinecraftRegionFiles(files.region, [{ ...externalFile, localX: -1 }]),
    )
    expectRegionFilesError(() =>
      decodeMinecraftRegionFiles(files.region, [{ ...externalFile, localZ: 32 }]),
    )
    expectRegionFilesError(() => decodeMinecraftRegionFiles(files.region, [externalFile, externalFile]))
    expectRegionFilesError(() => decodeMinecraftRegionFiles(files.region, []))
    expect(
      decodeMinecraftRegionFiles(files.region, [
        { localX: 5, localZ: 1, bytes: encodeMinecraftExternalChunkFile(new Uint8Array([8])) },
      ]).chunks[index],
    ).toMatchObject({ payload: new Uint8Array([8]) })
    expectRegionFilesError(() => decodeMinecraftRegionFiles(emptyBytes, [externalFile]))
    expectRegionFilesError(() =>
      decodeMinecraftRegionFiles(
        files.region,
        [{ ...externalFile, bytes: new Uint8Array([1, 2, 3]) }],
        { maxExternalBytes: 2 },
      ),
    )
    expect(() => decodeMinecraftRegionFiles(files.region, [externalFile], { maxExternalBytes: externalFile.bytes.byteLength })).not.toThrow()
    expect(() => decodeMinecraftRegionFiles(files.region, [externalFile], { maxRegionBytes: files.region.byteLength })).not.toThrow()
  })
})
