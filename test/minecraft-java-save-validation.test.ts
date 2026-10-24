import { describe, expect, it } from 'vitest'
import { Result } from 'effect'
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

const unwrapSuccess = <Success, Failure>(result: Result.Result<Success, Failure>): Success => {
  if (Result.isSuccess(result)) return result.success
  throw new Error('expected a successful Result')
}

const expectFailure = <Success>(result: Result.Result<Success, MinecraftJavaSaveError>, reason: string) => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(MinecraftJavaSaveError)
    expect(result.failure.reason).toContain(reason)
  }
}

const defaultOptions = unwrapSuccess(resolveMinecraftJavaSaveOptions(undefined))

const level = unwrapSuccess(nbtDocument('Level', unwrapSuccess(nbtCompound([]))))

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

const expectValidateFailure = (save: unknown, message: string) =>
  expectFailure(validateMinecraftJavaSave(save, defaultOptions), message)

const expectValidateSuccess = (save: unknown) =>
  expect(Result.isSuccess(validateMinecraftJavaSave(save, defaultOptions))).toBe(true)

const anvilChunk = (localX: number, localZ: number) => ({
  localX,
  localZ,
  timestamp: 1,
  compression: 'none' as const,
  payload: new Uint8Array(),
})

const fullChunks = (): Array<AnvilChunkRecord | null> =>
  Array.from({ length: ANVIL_CHUNK_COUNT }, (): AnvilChunkRecord | null => null)
const fullTimestamps = (): number[] => Array.from({ length: ANVIL_CHUNK_COUNT }, (): number => 0)

describe('resolveMinecraftJavaSaveOptions merge logic', () => {
  it('defaults to an empty compressedNbt when neither compressedNbt nor nbt is set', () => {
    expect(unwrapSuccess(resolveMinecraftJavaSaveOptions(undefined))).toMatchObject({ compressedNbt: {} })
    expect(unwrapSuccess(resolveMinecraftJavaSaveOptions({}))).toMatchObject({ compressedNbt: {} })
  })

  it('promotes a bare nbt option into compressedNbt.nbt when compressedNbt is absent', () => {
    const nbt = { maxDepth: 4 }
    expect(unwrapSuccess(resolveMinecraftJavaSaveOptions({ nbt }))).toMatchObject({ compressedNbt: { nbt }, nbt })
  })

  it('keeps an explicit compressedNbt as-is when it already carries its own nbt option', () => {
    const compressedNbt = { nbt: { maxDepth: 1 } }
    const resolved = unwrapSuccess(resolveMinecraftJavaSaveOptions({ compressedNbt, nbt: { maxDepth: 99 } }))
    expect(resolved.compressedNbt).toStrictEqual(compressedNbt)
    expect(resolved.compressedNbt).not.toBe(compressedNbt)
  })

  it('keeps an explicit compressedNbt as-is when no top-level nbt option is given', () => {
    const compressedNbt = { maxCompressedBytes: 10 }
    const resolved = unwrapSuccess(resolveMinecraftJavaSaveOptions({ compressedNbt }))
    expect(resolved.compressedNbt).toStrictEqual(compressedNbt)
    expect(resolved.compressedNbt).not.toBe(compressedNbt)
  })

  it('merges a top-level nbt option into compressedNbt when compressedNbt has none of its own', () => {
    const compressedNbt = { maxCompressedBytes: 10 }
    const nbt = { maxDepth: 2 }
    const resolved = unwrapSuccess(resolveMinecraftJavaSaveOptions({ compressedNbt, nbt }))
    expect(resolved.compressedNbt).toStrictEqual({ maxCompressedBytes: 10, nbt })
  })

  it('rejects out-of-range limits', () => {
    expectFailure(resolveMinecraftJavaSaveOptions({ maxFiles: -1 }), 'maxFiles')
    expectFailure(resolveMinecraftJavaSaveOptions({ maxFiles: 1.5 }), 'maxFiles')
    expectFailure(resolveMinecraftJavaSaveOptions({ maxFileBytes: -1 }), 'maxFileBytes')
    expectFailure(resolveMinecraftJavaSaveOptions({ maxTotalBytes: Number.POSITIVE_INFINITY }), 'maxTotalBytes')
    expectFailure(
      resolveMinecraftJavaSaveOptions(JSON.parse('{"nbt":{"maxBytes":1.5}}')),
      'nbt.maxBytes must be a safe integer',
    )
  })

  it('rejects option getters without invoking them', () => {
    let reads = 0
    const options = Object.defineProperty({}, 'maxFiles', {
      enumerable: true,
      get: () => {
        reads += 1
        return 3
      },
    })
    expectFailure(resolveMinecraftJavaSaveOptions(options), 'snapshot-safe')
    expect(reads).toBe(0)
  })

  it('rejects unsupported nested option keys', () => {
    // @ts-expect-error -- deliberately unsupported options to verify runtime rejection
    expectFailure(resolveMinecraftJavaSaveOptions({ nbt: { unknownLimit: 1 } }), 'nbt contains an unsupported option')
    expectFailure(
      // @ts-expect-error -- deliberately unsupported options to verify runtime rejection
      resolveMinecraftJavaSaveOptions({ compressedNbt: { unknownLimit: 1 } }),
      'compressedNbt contains an unsupported option',
    )
    // @ts-expect-error -- deliberately unsupported options to verify runtime rejection
    expectFailure(resolveMinecraftJavaSaveOptions({ region: { unknownLimit: 1 } }), 'region contains an unsupported option')
  })

  it('resolves every supported nested option field', () => {
    expect(
      unwrapSuccess(
        resolveMinecraftJavaSaveOptions({
          nbt: { maxBytes: 1, maxDepth: 2, maxElements: 3, maxStringBytes: 4 },
          compressedNbt: { maxCompressedBytes: 5, maxDecompressedBytes: 6 },
          region: { maxRegionBytes: 7, maxExternalBytes: 8 },
        }),
      ),
    ).toMatchObject({
      nbt: { maxBytes: 1, maxDepth: 2, maxElements: 3, maxStringBytes: 4 },
      compressedNbt: {
        maxCompressedBytes: 5,
        maxDecompressedBytes: 6,
        nbt: { maxBytes: 1, maxDepth: 2, maxElements: 3, maxStringBytes: 4 },
      },
      region: { maxRegionBytes: 7, maxExternalBytes: 8 },
    })
  })
})

describe('validateMinecraftJavaSaveFiles low-level boundary', () => {
  const options = defaultOptions

  it('rejects a non-string, empty, too-long, or unsafely shaped path', () => {
    // @ts-expect-error -- deliberately non-string path to verify runtime rejection
    const filesWithNumericPath: Array<{ path: string; bytes: Uint8Array }> = [{ path: 1, bytes: new Uint8Array() }]
    expectFailure(validateMinecraftJavaSaveFiles(filesWithNumericPath, options), 'must be a non-empty path')
    expectFailure(validateMinecraftJavaSaveFiles([{ path: '', bytes: new Uint8Array() }], options), 'must be a non-empty path')
    expectFailure(validateMinecraftJavaSaveFiles([{ path: 'a'.repeat(4097), bytes: new Uint8Array() }], options), 'must be a non-empty path')
    expectFailure(validateMinecraftJavaSaveFiles([{ path: '/absolute', bytes: new Uint8Array() }], options), 'relative forward-slash path')
    expectFailure(validateMinecraftJavaSaveFiles([{ path: 'trailing/', bytes: new Uint8Array() }], options), 'relative forward-slash path')
    expectFailure(validateMinecraftJavaSaveFiles([{ path: String.raw`back\\slash`, bytes: new Uint8Array() }], options), 'relative forward-slash path')
    expectFailure(validateMinecraftJavaSaveFiles([{ path: 'null\x00byte', bytes: new Uint8Array() }], options), 'relative forward-slash path')
    expectFailure(validateMinecraftJavaSaveFiles([{ path: 'a//b', bytes: new Uint8Array() }], options), 'unsafe path segment')
  })

  it('rejects a file exceeding the per-file byte limit while total bytes stay within range', () => {
    const files = [{ path: 'big.dat', bytes: new Uint8Array(10) }]
    expectFailure(validateMinecraftJavaSaveFiles(files, { ...options, maxFileBytes: 5 }), 'maxFileBytes')
  })

  it('rejects file payloads that are not Uint8Array values', () => {
    const files = JSON.parse('[{"path":"state.dat","bytes":[]}]')
    expectFailure(validateMinecraftJavaSaveFiles(files, options), 'bytes must be a Uint8Array')
  })

  it('accepts a safe nested relative file path', () => {
    const result = validateMinecraftJavaSaveFiles(
      [{ path: 'data/minecraft/state.dat', bytes: new Uint8Array([1]) }],
      options,
    )

    expect(Result.isSuccess(result)).toBe(true)
  })
})

describe('validateMinecraftJavaSave low-level boundary', () => {
  it('rejects a non-string dimension on a data file', () => {
    expectValidateFailure(
      { ...baseSave(), dataFiles: [{ namespace: 'minecraft', name: 'state.dat', dimension: 1, document: level }] },
      'dataFiles 0 dimension is invalid',
    )
  })

  it('rejects a region whose chunk record carries an unexpected key', () => {
    const chunks = fullChunks()
    const chunkWithExtraKey = { ...anvilChunk(0, 0), extra: true }
    chunks[0] = chunkWithExtraKey
    expectValidateFailure(
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
    expectValidateFailure(
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

  it('rejects a region whose timestamps array has the right length but a non-number entry', () => {
    const chunks = fullChunks()
    const timestamps = fullTimestamps()
    // @ts-expect-error -- deliberately non-number timestamp entry to verify runtime rejection
    timestamps[0] = 'not-a-number'
    expectValidateFailure(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks, timestamps },
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
    expectValidateFailure(
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
    expectValidateSuccess({
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
      })
  })

  it('returns a typed failure for values that are not save records', () => {
    expectValidateFailure(null, 'save must be an object')
    expectValidateFailure(42, 'save must be an object')
  })

  it('rejects a save value that owns a changing getter without invoking it', () => {
    let reads = 0
    const save = baseSave()
    Object.defineProperty(save, 'levelBackup', {
      enumerable: true,
      get: () => {
        reads += 1
        return level
      },
    })
    expectValidateFailure(save, 'snapshot-safe')
    expect(reads).toBe(0)
  })

  it('returns a detached snapshot of byte fields', () => {
    const icon = new Uint8Array([1, 2, 3])
    const result = validateMinecraftJavaSave({ ...baseSave(), icon }, defaultOptions)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      icon[0] = 9
      expect(result.success.icon).toEqual(new Uint8Array([1, 2, 3]))
      expect(result.success.icon).not.toBe(icon)
    }
  })

  it('accepts chunk compression values beyond the first two disjuncts', () => {
    const chunks: Array<AnvilChunkRecord | null> = fullChunks()
    chunks[0] = { ...anvilChunk(0, 0), compression: 'lz4' }
    chunks[1] = { ...anvilChunk(1, 0), compression: 'custom' }
    expectValidateSuccess({
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
      })
  })

  it('rejects an anvil chunk payload that is not a Uint8Array', () => {
    const chunks = fullChunks()
    // @ts-expect-error -- deliberately non-Uint8Array payload to verify runtime rejection
    chunks[0] = { ...anvilChunk(0, 0), payload: [1, 2, 3] }
    expectValidateFailure(
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

  it('rejects symbols, functions, and cycles while snapshotting a save', () => {
    expectValidateFailure({ ...baseSave(), icon: Symbol('icon') }, 'snapshot-safe')
    expectValidateFailure({ ...baseSave(), icon: () => new Uint8Array() }, 'snapshot-safe')

    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    expectValidateFailure({ ...baseSave(), extraFiles: [cycle] }, 'snapshot-safe')
  })

  it('rejects an array proxy with an invalid length descriptor', () => {
    const invalidLengthArray = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        return key === 'length' && descriptor !== undefined ? { ...descriptor, value: -1 } : descriptor
      },
    })

    expectValidateFailure({ ...baseSave(), extraFiles: invalidLengthArray }, 'snapshot-safe')
  })

  it('rejects arrays with non-index own properties at the snapshot boundary', () => {
    const malformed = new Array(1)
    Object.defineProperty(malformed, 'extra', { value: true, enumerable: true })

    expectValidateFailure({ ...baseSave(), extraFiles: malformed }, 'snapshot-safe')
  })

  it('accepts null-prototype save records and arrays', () => {
    const extraFiles = Object.setPrototypeOf([], null)
    const save = Object.assign(Object.create(null), { ...baseSave(), extraFiles })

    expectValidateSuccess(save)
  })

  it('rejects a region with a non-array chunk grid', () => {
    expectValidateFailure(
      {
        ...baseSave(),
        regions: [
          {
            dimension: 'overworld',
            storage: 'region',
            regionX: 0,
            regionZ: 0,
            region: { chunks: {}, timestamps: fullTimestamps() },
          },
        ],
      },
      'regions 0 is invalid',
    )
  })

  it('maps fractional region X and Z coordinates to typed validation failures', () => {
    const chunks = fullChunks()
    const timestamps = fullTimestamps()
    const region = (regionX: number, regionZ: number) => ({
      dimension: 'overworld',
      storage: 'region',
      regionX,
      regionZ,
      region: { chunks, timestamps },
    })

    expectValidateFailure({ ...baseSave(), regions: [region(1.5, 0)] }, 'regions 0 is invalid')
    expectValidateFailure({ ...baseSave(), regions: [region(0, 1.5)] }, 'regions 0 is invalid')
  })
})

describe('isRecord low-level boundary (via requireRecord in validateMinecraftJavaSaveFiles)', () => {
  const options = defaultOptions

  it('rejects an array or Uint8Array passed where a record is expected', () => {
    // @ts-expect-error -- deliberately non-record file entries to verify runtime rejection
    const arrayEntry: Array<{ path: string; bytes: Uint8Array }> = [[1, 2, 3]]
    expectFailure(validateMinecraftJavaSaveFiles(arrayEntry, options), 'must be an object')
    // @ts-expect-error -- deliberately non-record file entries to verify runtime rejection
    const byteArrayEntry: Array<{ path: string; bytes: Uint8Array }> = [new Uint8Array([1])]
    expectFailure(validateMinecraftJavaSaveFiles(byteArrayEntry, options), 'must be an object')
  })

  it('rejects a record carrying a non-string own key', () => {
    const withSymbolKey: Record<string | symbol, unknown> = { path: 'a', bytes: new Uint8Array() }
    withSymbolKey[Symbol('extra')] = true
    // @ts-expect-error -- deliberately mistyped record to verify runtime rejection
    const entries: Array<{ path: string; bytes: Uint8Array }> = [withSymbolKey]
    expectFailure(validateMinecraftJavaSaveFiles(entries, options), 'snapshot-safe')
  })

  it('rejects a record carrying a non-enumerable own key', () => {
    const withHiddenKey: Record<string, unknown> = { bytes: new Uint8Array() }
    Object.defineProperty(withHiddenKey, 'path', { value: 'a', enumerable: false, configurable: true })
    // @ts-expect-error -- deliberately mistyped record to verify runtime rejection
    const entries: Array<{ path: string; bytes: Uint8Array }> = [withHiddenKey]
    expectFailure(validateMinecraftJavaSaveFiles(entries, options), 'snapshot-safe')
  })
})

describe('isDenseArray and isByteArray defensive catch boundaries', () => {
  it('rejects region chunk/timestamp arrays whose own-key enumeration throws', () => {
    const throwingChunks = new Proxy(fullChunks(), { ownKeys: () => { throw new Error('hostile ownKeys') } })
    expectValidateFailure(
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
      'could not be snapshotted',
    )
  })

  it('rejects an anvil chunk payload whose own-key enumeration throws', () => {
    const throwingPayload = new Proxy(new Uint8Array([1, 2]), {
      ownKeys: () => {
        throw new Error('hostile ownKeys')
      },
    })
    const chunks = fullChunks()
    chunks[0] = { ...anvilChunk(0, 0), payload: throwingPayload }
    expectValidateFailure(
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
      'could not be snapshotted',
    )
  })

  it('rejects an anvil chunk payload that is not a Uint8Array or has a foreign prototype', () => {
    const chunks = fullChunks()
    const derivedBytes = new (class extends Uint8Array {})([1, 2])
    chunks[0] = { ...anvilChunk(0, 0), payload: derivedBytes }
    expectValidateFailure(
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
      'snapshot-safe',
    )
  })
})

describe('resolveMinecraftJavaSaveOptions region passthrough', () => {
  it('carries an explicit region option through unchanged', () => {
    const region = { maxRegionBytes: 10 }
    expect(unwrapSuccess(resolveMinecraftJavaSaveOptions({ region }))).toMatchObject({ region })

    const regionWithoutMaxRegionBytes = { maxExternalBytes: 10 }
    expect(
      unwrapSuccess(resolveMinecraftJavaSaveOptions({ region: regionWithoutMaxRegionBytes })),
    ).toMatchObject({ region: regionWithoutMaxRegionBytes })
  })
})
