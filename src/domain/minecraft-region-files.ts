import { Brand, Data, Result } from 'effect'
import type * as Cause from 'effect/Cause'
import {
  ANVIL_EXTERNAL_CHUNK_THRESHOLD,
  ANVIL_REGION_CHUNK_SIDE,
  ANVIL_SECTOR_BYTES,
  type AnvilChunkRecord,
  type AnvilRegion,
  type AnvilRegionError,
  type AnvilLocalCoordinate,
  anvilRegion,
  decodeAnvilRegion,
  encodeAnvilRegion,
} from './anvil-region.js'

export const MINECRAFT_EXTERNAL_CHUNK_DEFAULT_MAX_BYTES: number = 64 * 1024 * 1024
export type MinecraftExternalChunkByteLimit = number & Brand.Brand<'MinecraftExternalChunkByteLimit'>

type MinecraftRegionFilesErrorFields = { readonly reason: string }

const MinecraftRegionFilesErrorBase: new (args: MinecraftRegionFilesErrorFields) =>
  Cause.YieldableError & { readonly _tag: 'MinecraftRegionFilesError' } & Readonly<MinecraftRegionFilesErrorFields> =
  Data.TaggedError('MinecraftRegionFilesError')

export class MinecraftRegionFilesError extends MinecraftRegionFilesErrorBase {
  #messageOverride: string | undefined

  override get message(): string {
    return this.#messageOverride ?? `Minecraft region files are invalid: ${this.reason}`
  }

  override set message(value: string) {
    this.#messageOverride = value
  }
}

export type MinecraftExternalChunkFile = {
  readonly localX: AnvilLocalCoordinate
  readonly localZ: AnvilLocalCoordinate
  readonly bytes: Uint8Array
}

export type MinecraftRegionFiles = {
  readonly region: Uint8Array
  readonly externalChunks: ReadonlyArray<MinecraftExternalChunkFile>
}

export type MinecraftRegionFilesOptions = {
  readonly maxRegionBytes?: unknown
  readonly maxExternalBytes?: unknown
}

const regionFilesError = (reason: string): MinecraftRegionFilesError => new MinecraftRegionFilesError({ reason })

const resolveExternalMaxBytes = (maxBytes: unknown): Result.Result<MinecraftExternalChunkByteLimit, MinecraftRegionFilesError> => {
  const resolved = maxBytes === undefined ? MINECRAFT_EXTERNAL_CHUNK_DEFAULT_MAX_BYTES : maxBytes
  return typeof resolved === 'number' && Number.isSafeInteger(resolved) && resolved >= 0
    ? Result.succeed(Brand.nominal<MinecraftExternalChunkByteLimit>()(resolved))
    : Result.fail(regionFilesError('maxExternalBytes must be a non-negative safe integer'))
}

const assertLocalCoordinate = (
  value: unknown,
  name: string,
): Result.Result<AnvilLocalCoordinate, MinecraftRegionFilesError> => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= ANVIL_REGION_CHUNK_SIDE) {
    return Result.fail(regionFilesError(`${name} must be an integer between 0 and 31`))
  }
  return Result.succeed(Brand.nominal<AnvilLocalCoordinate>()(value))
}

const assertPayload = (payload: Uint8Array): Result.Result<void, MinecraftRegionFilesError> =>
  payload instanceof Uint8Array
    ? Result.succeed(undefined)
    : Result.fail(regionFilesError('payload must be a Uint8Array'))

const chunkIndex = (localX: number, localZ: number): number => localX + localZ * ANVIL_REGION_CHUNK_SIDE

const externalOptions = (maxBytes: unknown): { readonly maxBytes?: unknown } =>
  maxBytes === undefined ? {} : { maxBytes }

const regionOptions = (maxBytes: unknown): { readonly maxBytes?: unknown } =>
  maxBytes === undefined ? {} : { maxBytes }

const readFileOptions = (
  options: unknown,
): Result.Result<{ readonly maxRegionBytes: unknown; readonly maxExternalBytes: unknown }, MinecraftRegionFilesError> =>
  Result.gen(function* () {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Result.fail(regionFilesError('region file options could not be read'))
    }
    return yield* Result.try({
      try: () => options === undefined
        ? { maxRegionBytes: undefined, maxExternalBytes: undefined }
        : {
            maxRegionBytes: Reflect.get(options, 'maxRegionBytes'),
            maxExternalBytes: Reflect.get(options, 'maxExternalBytes'),
          },
      catch: () => regionFilesError('region file options could not be read'),
    })
  })

export const encodeMinecraftExternalChunkFile = (
  payload: Uint8Array,
  options?: unknown,
): Result.Result<Uint8Array, MinecraftRegionFilesError> =>
  Result.gen(function* () {
    yield* assertPayload(payload)
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Result.fail(regionFilesError('external chunk options could not be read'))
    }
    const maxBytesValue = yield* Result.try({
      try: () => options === undefined ? undefined : Reflect.get(options, 'maxBytes'),
      catch: () => regionFilesError('external chunk options could not be read'),
    })
    const maxBytes = yield* resolveExternalMaxBytes(maxBytesValue)
    const snapshot = yield* Result.try({
      try: () => payload.slice(),
      catch: () => regionFilesError('external chunk payload could not be copied'),
    })
    if (snapshot.byteLength > maxBytes) return yield* Result.fail(regionFilesError(`external chunk exceeds maxBytes ${String(maxBytes)}`))
    return snapshot
  })

export const decodeMinecraftExternalChunkFile = (
  bytes: Uint8Array,
  options?: unknown,
): Result.Result<Uint8Array, MinecraftRegionFilesError> =>
  Result.gen(function* () {
    yield* assertPayload(bytes)
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Result.fail(regionFilesError('external chunk options could not be read'))
    }
    const maxBytesValue = yield* Result.try({
      try: () => options === undefined ? undefined : Reflect.get(options, 'maxBytes'),
      catch: () => regionFilesError('external chunk options could not be read'),
    })
    const maxBytes = yield* resolveExternalMaxBytes(maxBytesValue)
    const snapshot = yield* Result.try({
      try: () => bytes.slice(),
      catch: () => regionFilesError('external chunk input could not be copied'),
    })
    if (snapshot.byteLength > maxBytes) return yield* Result.fail(regionFilesError(`external chunk exceeds maxBytes ${String(maxBytes)}`))
    return snapshot
  })

const externalFileKey = (localX: unknown, localZ: unknown): Result.Result<number, MinecraftRegionFilesError> =>
  Result.gen(function* () {
    const x = yield* assertLocalCoordinate(localX, 'localX')
    const z = yield* assertLocalCoordinate(localZ, 'localZ')
    return chunkIndex(x, z)
  })

const shouldExternalize = (chunk: AnvilChunkRecord | null | undefined): chunk is AnvilChunkRecord =>
  chunk !== null &&
  chunk !== undefined &&
  chunk.payload instanceof Uint8Array &&
  (chunk.external === true ||
    ((chunk.external === undefined || chunk.external === false) &&
      Math.ceil((5 + chunk.payload.byteLength) / ANVIL_SECTOR_BYTES) >= ANVIL_EXTERNAL_CHUNK_THRESHOLD))

export const encodeMinecraftRegionFiles = (
  region: AnvilRegion,
  options?: unknown,
): Result.Result<MinecraftRegionFiles, AnvilRegionError | MinecraftRegionFilesError> =>
  Result.gen(function* () {
    const optionValues = yield* readFileOptions(options)
    const snapshot = yield* Result.try({
      try: () => structuredClone(region),
      catch: () => regionFilesError('region could not be copied'),
    })
    if (snapshot === null || typeof snapshot !== 'object') return yield* Result.fail(regionFilesError('region must be an object'))
    if (!Array.isArray(snapshot.chunks) || !Array.isArray(snapshot.timestamps)) {
      return yield* Result.fail(regionFilesError('region chunks and timestamps must be arrays'))
    }
    const externalPayloads = new Map<number, Uint8Array>()
    const chunksForValidation = snapshot.chunks.map((chunk, index) => {
      if (!shouldExternalize(chunk)) return chunk
      externalPayloads.set(index, chunk.payload)
      return { ...chunk, payload: new Uint8Array(), external: true }
    })
    const normalized = yield* anvilRegion(chunksForValidation, snapshot.timestamps)
    const externalChunks: MinecraftExternalChunkFile[] = []
    const regionChunks: Array<AnvilChunkRecord | null> = []
    for (const [index, chunk] of normalized.chunks.entries()) {
      if (chunk === null) {
        regionChunks.push(null)
        continue
      }
      const payload = externalPayloads.get(index)
      if (payload === undefined) {
        regionChunks.push(chunk)
        continue
      }
      const externalBytes = yield* encodeMinecraftExternalChunkFile(payload, externalOptions(optionValues.maxExternalBytes))
      externalChunks.push({ localX: chunk.localX, localZ: chunk.localZ, bytes: externalBytes })
      regionChunks.push(chunk)
    }
    const encodedRegion = yield* encodeAnvilRegion(
      { chunks: regionChunks, timestamps: normalized.timestamps },
      regionOptions(optionValues.maxRegionBytes),
    )
    return { region: encodedRegion, externalChunks }
  })

export const decodeMinecraftRegionFiles = (
  regionBytes: Uint8Array,
  externalChunks: unknown,
  options?: unknown,
): Result.Result<AnvilRegion, AnvilRegionError | MinecraftRegionFilesError> =>
  Result.gen(function* () {
    const optionValues = yield* readFileOptions(options)
    const regionSnapshot = yield* Result.try({
      try: () => regionBytes.slice(),
      catch: () => regionFilesError('region bytes could not be copied'),
    })
    const externalSnapshot = yield* Result.try({
      try: () => structuredClone(externalChunks),
      catch: () => regionFilesError('external chunks could not be copied'),
    })
    const region = yield* decodeAnvilRegion(regionSnapshot, regionOptions(optionValues.maxRegionBytes))
    if (!Array.isArray(externalSnapshot)) return yield* Result.fail(regionFilesError('externalChunks must be an array'))
    const records = new Map<number, Uint8Array>()
    for (const file of externalSnapshot) {
      if (file === null || typeof file !== 'object') return yield* Result.fail(regionFilesError('external chunk file must be an object'))
      const fields = {
        localX: Reflect.get(file, 'localX'),
        localZ: Reflect.get(file, 'localZ'),
        bytes: Reflect.get(file, 'bytes'),
      }
      const { localX, localZ, bytes } = fields
      const key = yield* externalFileKey(localX, localZ)
      if (records.has(key)) {
        return yield* Result.fail(regionFilesError(`duplicate external chunk coordinates ${String(localX)},${String(localZ)}`))
      }
      if (!(bytes instanceof Uint8Array)) return yield* Result.fail(regionFilesError('external chunk bytes must be a Uint8Array'))
      const payload = yield* decodeMinecraftExternalChunkFile(bytes, externalOptions(optionValues.maxExternalBytes))
      records.set(key, payload)
    }

    const chunks: Array<AnvilChunkRecord | null> = []
    for (const [index, chunk] of region.chunks.entries()) {
      if (chunk === null || chunk.external !== true) {
        if (records.has(index)) return yield* Result.fail(regionFilesError(`external chunk has no matching region stub at slot ${String(index)}`))
        chunks.push(chunk)
        continue
      }
      const payload = records.get(index)
      if (payload === undefined) return yield* Result.fail(regionFilesError(`region stub at slot ${String(index)} has no external chunk file`))
      chunks.push({ ...chunk, payload })
    }
    return yield* anvilRegion(chunks, region.timestamps)
  })
