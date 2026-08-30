import { describe, expect, it } from 'vitest'
import {
  ANVIL_CHUNK_COUNT,
  nbtCompound,
  nbtDocument,
  MinecraftJavaSaveError,
  type AnvilChunkRecord,
  type MinecraftJavaSave,
} from '../src/index.js'
import {
  resolveMinecraftJavaSaveOptions,
  validateMinecraftJavaSave,
  validateMinecraftJavaSaveFiles,
} from '../src/domain/minecraft-java-save-validation.js'

const level = nbtDocument('Level', nbtCompound([]))

const baseSave = (): MinecraftJavaSave => ({
  level,
  playerData: [],
  playerStats: [],
  playerAdvancements: [],
  regions: [],
  dataFiles: [],
  worldClocks: [],
  structures: [],
  extraFiles: [],
})

const expectValidateThrows = (save: unknown, message: string) =>
  expect(() => validateMinecraftJavaSave(save)).toThrow(message)

const anvilChunk = (localX: number, localZ: number) => ({
  localX,
  localZ,
  timestamp: 1,
  compression: 'none' as const,
  payload: new Uint8Array(),
})

const fullChunks = () => new Array(ANVIL_CHUNK_COUNT).fill(null) as Array<ReturnType<typeof anvilChunk> | null>
const fullTimestamps = () => new Array(ANVIL_CHUNK_COUNT).fill(0) as number[]

describe('resolveMinecraftJavaSaveOptions merge logic', () => {
  it('defaults to an empty compressedNbt when neither compressedNbt nor nbt is set', () => {
    expect(resolveMinecraftJavaSaveOptions(undefined)).toMatchObject({ compressedNbt: {} })
    expect(resolveMinecraftJavaSaveOptions({})).toMatchObject({ compressedNbt: {} })
  })

  it('promotes a bare nbt option into compressedNbt.nbt when compressedNbt is absent', () => {
    const nbt = { maxDepth: 4 }
    expect(resolveMinecraftJavaSaveOptions({ nbt })).toMatchObject({ compressedNbt: { nbt }, nbt })
  })

  it('keeps an explicit compressedNbt as-is when it already carries its own nbt option', () => {
    const compressedNbt = { nbt: { maxDepth: 1 } }
    const resolved = resolveMinecraftJavaSaveOptions({ compressedNbt, nbt: { maxDepth: 99 } })
    expect(resolved.compressedNbt).toBe(compressedNbt)
  })

  it('keeps an explicit compressedNbt as-is when no top-level nbt option is given', () => {
    const compressedNbt = { maxCompressedBytes: 10 }
    const resolved = resolveMinecraftJavaSaveOptions({ compressedNbt })
    expect(resolved.compressedNbt).toBe(compressedNbt)
  })

  it('merges a top-level nbt option into compressedNbt when compressedNbt has none of its own', () => {
    const compressedNbt = { maxCompressedBytes: 10 }
    const nbt = { maxDepth: 2 }
    const resolved = resolveMinecraftJavaSaveOptions({ compressedNbt, nbt })
    expect(resolved.compressedNbt).toStrictEqual({ maxCompressedBytes: 10, nbt })
  })

  it('rejects out-of-range limits', () => {
    expect(() => resolveMinecraftJavaSaveOptions({ maxFiles: -1 })).toThrow('maxFiles')
    expect(() => resolveMinecraftJavaSaveOptions({ maxFiles: 1.5 })).toThrow('maxFiles')
    expect(() => resolveMinecraftJavaSaveOptions({ maxFileBytes: -1 })).toThrow('maxFileBytes')
    expect(() => resolveMinecraftJavaSaveOptions({ maxTotalBytes: Number.POSITIVE_INFINITY })).toThrow('maxTotalBytes')
  })
})

describe('validateMinecraftJavaSaveFiles low-level boundary', () => {
  const options = resolveMinecraftJavaSaveOptions(undefined)

  it('rejects a non-string, empty, too-long, or unsafely shaped path', () => {
    expect(() => validateMinecraftJavaSaveFiles([{ path: 1 as never, bytes: new Uint8Array() }], options)).toThrow(
      'must be a non-empty path',
    )
    expect(() => validateMinecraftJavaSaveFiles([{ path: '', bytes: new Uint8Array() }], options)).toThrow(
      'must be a non-empty path',
    )
    expect(() =>
      validateMinecraftJavaSaveFiles([{ path: 'a'.repeat(4097), bytes: new Uint8Array() }], options),
    ).toThrow('must be a non-empty path')
    expect(() => validateMinecraftJavaSaveFiles([{ path: '/absolute', bytes: new Uint8Array() }], options)).toThrow(
      'relative forward-slash path',
    )
    expect(() => validateMinecraftJavaSaveFiles([{ path: 'trailing/', bytes: new Uint8Array() }], options)).toThrow(
      'relative forward-slash path',
    )
    expect(() =>
      validateMinecraftJavaSaveFiles([{ path: String.raw`back\slash`, bytes: new Uint8Array() }], options),
    ).toThrow('relative forward-slash path')
    expect(() =>
      validateMinecraftJavaSaveFiles([{ path: 'null\x00byte', bytes: new Uint8Array() }], options),
    ).toThrow('relative forward-slash path')
    expect(() => validateMinecraftJavaSaveFiles([{ path: 'a//b', bytes: new Uint8Array() }], options)).toThrow(
      'unsafe path segment',
    )
  })

  it('rejects a file exceeding the per-file byte limit while total bytes stay within range', () => {
    const files = [{ path: 'big.dat', bytes: new Uint8Array(10) }]
    expect(() => validateMinecraftJavaSaveFiles(files, { ...options, maxFileBytes: 5 })).toThrow('maxFileBytes')
  })
})

describe('validateMinecraftJavaSave low-level boundary', () => {
  it('rejects a non-string dimension on a data file', () => {
    expectValidateThrows(
      { ...baseSave(), dataFiles: [{ namespace: 'minecraft', name: 'state.dat', dimension: 1, document: level }] },
      'dataFiles 0 dimension is invalid',
    )
  })

  it('rejects a region whose chunk record carries an unexpected key', () => {
    const chunks = fullChunks()
    chunks[0] = { ...anvilChunk(0, 0), extra: true } as never
    expectValidateThrows(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks, timestamps: fullTimestamps() },
          },
        ],
      },
      'regions 0 is invalid',
    )
  })

  it('rejects a region whose timestamps array has the wrong length', () => {
    const chunks = fullChunks()
    expectValidateThrows(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks, timestamps: fullTimestamps().slice(0, -1) },
          },
        ],
      },
      'regions 0 is invalid',
    )
  })

  it('rejects a region whose chunks are individually well-shaped but positioned at the wrong slot', () => {
    const chunks = fullChunks()
    // Every per-item field is valid, but slot 1 must hold localX=1,localZ=0 (index % 32, floor(index/32));
    // placing a slot-0-shaped chunk there passes isAnvilChunk yet fails anvilRegion's positional check.
    chunks[1] = anvilChunk(0, 0)
    expectValidateThrows(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks, timestamps: fullTimestamps() },
          },
        ],
      },
      'regions 0 is invalid',
    )
  })

  it('accepts a fully empty region grid', () => {
    expect(() =>
      validateMinecraftJavaSave({
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks: fullChunks(), timestamps: fullTimestamps() },
          },
        ],
      }),
    ).not.toThrow()
  })

  it('rejects save values that are not MinecraftJavaSaveError instances underneath', () => {
    expect(() => validateMinecraftJavaSave(null)).toThrow(MinecraftJavaSaveError)
    expect(() => validateMinecraftJavaSave(42)).toThrow('save must be an object')
  })

  it('accepts chunk compression values beyond the first two disjuncts', () => {
    const chunks: Array<AnvilChunkRecord | null> = fullChunks()
    chunks[0] = { ...anvilChunk(0, 0), compression: 'lz4' }
    chunks[1] = { ...anvilChunk(1, 0), compression: 'custom' }
    expect(() =>
      validateMinecraftJavaSave({
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks, timestamps: fullTimestamps() },
          },
        ],
      }),
    ).not.toThrow()
  })

  it('rejects an anvil chunk payload that is not a Uint8Array', () => {
    const chunks = fullChunks()
    chunks[0] = { ...anvilChunk(0, 0), payload: [1, 2, 3] } as never
    expectValidateThrows(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks, timestamps: fullTimestamps() },
          },
        ],
      },
      'regions 0 is invalid',
    )
  })
})

describe('isRecord low-level boundary (via requireRecord in validateMinecraftJavaSaveFiles)', () => {
  const options = resolveMinecraftJavaSaveOptions(undefined)

  it('rejects an array or Uint8Array passed where a record is expected', () => {
    expect(() => validateMinecraftJavaSaveFiles([[1, 2, 3] as never], options)).toThrow('must be an object')
    expect(() => validateMinecraftJavaSaveFiles([new Uint8Array([1]) as never], options)).toThrow('must be an object')
  })

  it('rejects a record carrying a non-string own key', () => {
    const withSymbolKey: Record<string | symbol, unknown> = { path: 'a', bytes: new Uint8Array() }
    withSymbolKey[Symbol('extra')] = true
    expect(() => validateMinecraftJavaSaveFiles([withSymbolKey as never], options)).toThrow('must be an object')
  })

  it('rejects a record carrying a non-enumerable own key', () => {
    const withHiddenKey: Record<string, unknown> = { bytes: new Uint8Array() }
    Object.defineProperty(withHiddenKey, 'path', { value: 'a', enumerable: false, configurable: true })
    expect(() => validateMinecraftJavaSaveFiles([withHiddenKey as never], options)).toThrow('must be an object')
  })
})

describe('isDenseArray and isByteArray defensive catch boundaries', () => {
  it('rejects region chunk/timestamp arrays whose own-key enumeration throws', () => {
    const throwingChunks = new Proxy(fullChunks(), { ownKeys: () => { throw new Error('hostile ownKeys') } })
    expectValidateThrows(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks: throwingChunks, timestamps: fullTimestamps() },
          },
        ],
      },
      'regions 0 is invalid',
    )
  })

  it('rejects an anvil chunk payload whose own-key enumeration throws', () => {
    const throwingPayload = new Proxy(new Uint8Array([1, 2]), {
      ownKeys: () => {
        throw new Error('hostile ownKeys')
      },
    })
    const chunks = fullChunks()
    chunks[0] = { ...anvilChunk(0, 0), payload: throwingPayload as never }
    expectValidateThrows(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks, timestamps: fullTimestamps() },
          },
        ],
      },
      'regions 0 is invalid',
    )
  })

  it('rejects an anvil chunk payload that is not a Uint8Array or has a foreign prototype', () => {
    const chunks = fullChunks()
    const derivedBytes = new (class extends Uint8Array {})([1, 2])
    chunks[0] = { ...anvilChunk(0, 0), payload: derivedBytes }
    expectValidateThrows(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks, timestamps: fullTimestamps() },
          },
        ],
      },
      'regions 0 is invalid',
    )
  })
})

describe('resolveMinecraftJavaSaveOptions region passthrough', () => {
  it('carries an explicit region option through unchanged', () => {
    const region = { maxRegionBytes: 10 }
    expect(resolveMinecraftJavaSaveOptions({ region })).toMatchObject({ region })
  })
})
