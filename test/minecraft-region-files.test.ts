import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  ANVIL_CHUNK_COUNT,
  ANVIL_HEADER_BYTES,
  ANVIL_MAX_CHUNK_SECTORS,
  ANVIL_SECTOR_BYTES,
  type AnvilCompression,
  type AnvilChunkRecord,
  type AnvilRegion,
  anvilRegion as anvilRegionResult,
  decodeAnvilRegion as decodeAnvilRegionResult,
} from '../src/domain/anvil-region.js'
import {
  MinecraftRegionFilesError,
  decodeMinecraftExternalChunkFile as decodeMinecraftExternalChunkFileResult,
  decodeMinecraftRegionFiles as decodeMinecraftRegionFilesResult,
  encodeMinecraftExternalChunkFile as encodeMinecraftExternalChunkFileResult,
  encodeMinecraftRegionFiles as encodeMinecraftRegionFilesResult,
} from '../src/domain/minecraft-region-files.js'

const anvilRegion = (...args: Parameters<typeof anvilRegionResult>) => Result.getOrThrow(anvilRegionResult(...args))
const decodeAnvilRegion = (...args: Parameters<typeof decodeAnvilRegionResult>) => Result.getOrThrow(decodeAnvilRegionResult(...args))
const decodeMinecraftExternalChunkFile = (...args: Parameters<typeof decodeMinecraftExternalChunkFileResult>) => Result.getOrThrow(decodeMinecraftExternalChunkFileResult(...args))
const decodeMinecraftRegionFiles = (...args: Parameters<typeof decodeMinecraftRegionFilesResult>) => Result.getOrThrow(decodeMinecraftRegionFilesResult(...args))
const encodeMinecraftExternalChunkFile = (...args: Parameters<typeof encodeMinecraftExternalChunkFileResult>) => Result.getOrThrow(encodeMinecraftExternalChunkFileResult(...args))
const encodeMinecraftRegionFiles = (...args: Parameters<typeof encodeMinecraftRegionFilesResult>) => Result.getOrThrow(encodeMinecraftRegionFilesResult(...args))

const emptySlots = (): Array<null> => new Array(ANVIL_CHUNK_COUNT).fill(null)

const timestamps = (value = 0): AnvilRegion['timestamps'] =>
  Result.getOrThrow(anvilRegionResult(emptySlots(), new Array(ANVIL_CHUNK_COUNT).fill(value))).timestamps

const slotsWith = (index: number, chunk: AnvilChunkRecord): Array<AnvilChunkRecord | null> => {
  const slots: Array<AnvilChunkRecord | null> = emptySlots()
  slots[index] = chunk
  return slots
}

const chunkAt = (
  index: number,
  payload = new Uint8Array([1, 2, 3]),
  compression: AnvilCompression = 'none',
  timestamp = 7,
): AnvilChunkRecord => {
  const chunks: unknown[] = new Array(ANVIL_CHUNK_COUNT).fill(null)
  chunks[index] = {
    localX: index % 32,
    localZ: Math.floor(index / 32),
    timestamp,
    compression,
    payload,
  }
  const chunk = Result.getOrThrow(anvilRegionResult(chunks)).chunks[index]
  if (chunk === null || chunk === undefined) throw new Error('expected a validated chunk')
  return chunk
}

const emptyRegion = (): ReturnType<typeof anvilRegion> => anvilRegion(emptySlots(), timestamps())

const expectRegionFilesError = (operation: () => unknown): void => {
  expect(operation).toThrowError(MinecraftRegionFilesError)
}

describe('Minecraft external region file codec', () => {
  it('keeps the inherited Error.message field writable', () => {
    const error = new MinecraftRegionFilesError({ reason: 'bad region' })

    error.message = 'custom message'

    expect(error.message).toBe('custom message')
  })

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
    expectRegionFilesError(() => {
      // @ts-expect-error -- deliberately not a Uint8Array
      encodeMinecraftExternalChunkFile(null)
    })
    expectRegionFilesError(() => {
      // @ts-expect-error -- deliberately not a Uint8Array
      encodeMinecraftExternalChunkFile([1])
    })
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: 2 }))
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: 8.5 }))
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: -1 }))
    expectRegionFilesError(() =>
      encodeMinecraftExternalChunkFile(payload, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }),
    )
    expect(() => encodeMinecraftExternalChunkFile(payload, { maxBytes: Number.MAX_SAFE_INTEGER })).not.toThrow()

    expectRegionFilesError(() => {
      // @ts-expect-error -- deliberately not a Uint8Array
      decodeMinecraftExternalChunkFile(null)
    })
    expect(decodeMinecraftExternalChunkFile(valid)).toStrictEqual(new Uint8Array())
    expectRegionFilesError(() => decodeMinecraftExternalChunkFile(validPayloadFile, { maxBytes: 2 }))
    expectRegionFilesError(() => decodeMinecraftExternalChunkFile(validPayloadFile, { maxBytes: -1 }))
  })

  it('maps external option and byte-copy failures to the public error type', () => {
    const payload = new Uint8Array([1, 2, 3])
    const unreadableOptions = Object.defineProperty({}, 'maxBytes', {
      get: () => {
        throw new Error('unreadable maxBytes')
      },
    })

    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(payload, unreadableOptions))
    expectRegionFilesError(() => decodeMinecraftExternalChunkFile(payload, unreadableOptions))
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(payload, null))
    expectRegionFilesError(() => decodeMinecraftExternalChunkFile(payload, null))

    const unreadablePayload = new Uint8Array([1])
    Object.defineProperty(unreadablePayload, 'slice', {
      get: () => {
        throw new Error('unreadable slice')
      },
    })
    expectRegionFilesError(() => encodeMinecraftExternalChunkFile(unreadablePayload))
    expectRegionFilesError(() => decodeMinecraftExternalChunkFile(unreadablePayload))

    const errorResult = encodeMinecraftExternalChunkFileResult(payload, { maxBytes: 0 })
    expect(Result.isFailure(errorResult)).toBe(true)
    if (Result.isFailure(errorResult)) {
      expect(errorResult.failure.message).toBe('Minecraft region files are invalid: external chunk exceeds maxBytes 0')
    }
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

  it('keeps an explicitly inline chunk in the region file', () => {
    const index = 15
    const payload = new Uint8Array([4, 5, 6])
    const source = anvilRegion(
      slotsWith(index, { ...chunkAt(index, payload), external: false }),
      timestamps(),
    )
    const files = encodeMinecraftRegionFiles(source)
    const decoded = decodeAnvilRegion(files.region).chunks[index]

    expect(files.externalChunks).toHaveLength(0)
    expect(decoded).toMatchObject({ payload })
  })

  it('automatically externalizes payloads that exceed the local sector threshold', () => {
    const index = 2
    const payload = new Uint8Array(ANVIL_MAX_CHUNK_SECTORS * ANVIL_SECTOR_BYTES - 4).fill(7)
    const source = { chunks: slotsWith(index, chunkAt(index, payload)), timestamps: timestamps() }
    const files = encodeMinecraftRegionFiles(source)
    const stub = decodeAnvilRegion(files.region).chunks[index]
    const externalBytes = files.externalChunks[0]?.bytes

    expect(files.externalChunks).toHaveLength(1)
    expect(externalBytes?.byteLength).toBe(payload.byteLength)
    expect(externalBytes?.every((byte, payloadIndex) => byte === payload[payloadIndex])).toBe(true)
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
    expect(files.externalChunks).toHaveLength(1)
    const [externalFile] = files.externalChunks
    if (externalFile === undefined) throw new Error('expected exactly one external chunk file')
    const emptyBytes = encodeMinecraftRegionFiles(emptyRegion(), { maxRegionBytes: ANVIL_HEADER_BYTES }).region

    expectRegionFilesError(() => {
      // @ts-expect-error -- deliberately not an AnvilRegion
      encodeMinecraftRegionFiles(null)
    })
    expectRegionFilesError(() => {
      // @ts-expect-error -- deliberately not an AnvilRegion (chunks is not an array)
      encodeMinecraftRegionFiles({ chunks: null, timestamps: [] })
    })
    expectRegionFilesError(() => {
      decodeMinecraftRegionFiles(emptyBytes, null)
    })
    expectRegionFilesError(() => {
      decodeMinecraftRegionFiles(files.region, [null])
    })
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

  it('maps region option, byte-copy, and structured-clone failures', () => {
    const unreadableOptions = Object.defineProperty({}, 'maxRegionBytes', {
      get: () => {
        throw new Error('unreadable maxRegionBytes')
      },
    })
    const encodedEmptyRegion = encodeMinecraftRegionFiles(emptyRegion()).region

    expectRegionFilesError(() => encodeMinecraftRegionFiles(emptyRegion(), unreadableOptions))
    expectRegionFilesError(() => decodeMinecraftRegionFiles(encodedEmptyRegion, [], unreadableOptions))

    const uncloneableRegion = Object.assign(emptyRegion(), { callback: () => undefined })
    expectRegionFilesError(() => encodeMinecraftRegionFiles(uncloneableRegion))

    const unreadableRegionBytes = encodedEmptyRegion.slice()
    Object.defineProperty(unreadableRegionBytes, 'slice', {
      get: () => {
        throw new Error('unreadable region slice')
      },
    })
    expectRegionFilesError(() => decodeMinecraftRegionFiles(unreadableRegionBytes, []))

    const uncloneableExternalFiles = [
      { localX: 0, localZ: 0, bytes: new Uint8Array(), callback: () => undefined },
    ]
    expectRegionFilesError(() => decodeMinecraftRegionFiles(encodedEmptyRegion, uncloneableExternalFiles))
  })
})
