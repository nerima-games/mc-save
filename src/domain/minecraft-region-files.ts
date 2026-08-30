import {
  ANVIL_EXTERNAL_CHUNK_THRESHOLD,
  ANVIL_REGION_CHUNK_SIDE,
  ANVIL_SECTOR_BYTES,
  type AnvilChunkRecord,
  type AnvilRegion,
  anvilRegion,
  decodeAnvilRegion,
  encodeAnvilRegion,
} from './anvil-region.js'

export const MINECRAFT_EXTERNAL_CHUNK_DEFAULT_MAX_BYTES = 64 * 1024 * 1024

export class MinecraftRegionFilesError extends Error {
  readonly _tag = 'MinecraftRegionFilesError'
  readonly reason: string

  constructor(reason: string) {
    super(`Minecraft region files are invalid: ${reason}`)
    this.name = 'MinecraftRegionFilesError'
    this.reason = reason
  }
}

export type MinecraftExternalChunkFile = {
  readonly localX: number
  readonly localZ: number
  readonly bytes: Uint8Array
}

export type MinecraftRegionFiles = {
  readonly region: Uint8Array
  readonly externalChunks: ReadonlyArray<MinecraftExternalChunkFile>
}

export type MinecraftRegionFilesOptions = {
  readonly maxRegionBytes?: number
  readonly maxExternalBytes?: number
}

const regionFilesError = (reason: string): MinecraftRegionFilesError => new MinecraftRegionFilesError(reason)

const resolveExternalMaxBytes = (maxBytes: number | undefined): number => {
  const resolved = maxBytes ?? MINECRAFT_EXTERNAL_CHUNK_DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw regionFilesError('maxExternalBytes must be a non-negative safe integer')
  }
  return resolved
}

const assertLocalCoordinate = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0 || value >= ANVIL_REGION_CHUNK_SIDE) {
    throw regionFilesError(`${name} must be an integer between 0 and 31`)
  }
}

const assertPayload = (payload: Uint8Array): void => {
  if (!(payload instanceof Uint8Array)) throw regionFilesError('payload must be a Uint8Array')
}

const chunkIndex = (localX: number, localZ: number): number => localX + localZ * ANVIL_REGION_CHUNK_SIDE

const externalOptions = (maxBytes: number | undefined): { readonly maxBytes?: number } =>
  maxBytes === undefined ? {} : { maxBytes }

const regionOptions = (maxBytes: number | undefined): { readonly maxBytes?: number } =>
  maxBytes === undefined ? {} : { maxBytes }

export const encodeMinecraftExternalChunkFile = (
  payload: Uint8Array,
  options?: { readonly maxBytes?: number },
): Uint8Array => {
  assertPayload(payload)
  const maxBytes = resolveExternalMaxBytes(options?.maxBytes)
  if (payload.byteLength > maxBytes) throw regionFilesError(`external chunk exceeds maxBytes ${String(maxBytes)}`)
  return payload.slice()
}

export const decodeMinecraftExternalChunkFile = (
  bytes: Uint8Array,
  options?: { readonly maxBytes?: number },
): Uint8Array => {
  const maxBytes = resolveExternalMaxBytes(options?.maxBytes)
  if (!(bytes instanceof Uint8Array)) throw regionFilesError('external chunk input must be a Uint8Array')
  if (bytes.byteLength > maxBytes) throw regionFilesError(`external chunk exceeds maxBytes ${String(maxBytes)}`)
  return bytes.slice()
}

const externalFileKey = (localX: number, localZ: number): number => {
  assertLocalCoordinate(localX, 'localX')
  assertLocalCoordinate(localZ, 'localZ')
  return chunkIndex(localX, localZ)
}

const shouldExternalize = (chunk: AnvilChunkRecord | null | undefined): boolean =>
  chunk !== null &&
  chunk !== undefined &&
  chunk.external !== true &&
  chunk.payload instanceof Uint8Array &&
  Math.ceil((5 + chunk.payload.byteLength) / ANVIL_SECTOR_BYTES) >= ANVIL_EXTERNAL_CHUNK_THRESHOLD

export const encodeMinecraftRegionFiles = (
  region: AnvilRegion,
  options?: MinecraftRegionFilesOptions,
): MinecraftRegionFiles => {
  if (region === null || typeof region !== 'object') throw regionFilesError('region must be an object')
  if (!Array.isArray(region.chunks) || !Array.isArray(region.timestamps)) {
    throw regionFilesError('region chunks and timestamps must be arrays')
  }
  const preparedChunks = region.chunks.map((chunk) => (shouldExternalize(chunk) ? { ...chunk, external: true } : chunk))
  const normalized = anvilRegion(preparedChunks, region.timestamps)
  const externalChunks: MinecraftExternalChunkFile[] = []
  const regionChunks = normalized.chunks.map((chunk) => {
    if (chunk === null || chunk.external !== true) return chunk
    externalChunks.push({
      localX: chunk.localX,
      localZ: chunk.localZ,
      bytes: encodeMinecraftExternalChunkFile(chunk.payload, externalOptions(options?.maxExternalBytes)),
    })
    return { ...chunk, payload: new Uint8Array() }
  })
  return {
    region: encodeAnvilRegion(
      { chunks: regionChunks, timestamps: normalized.timestamps },
      regionOptions(options?.maxRegionBytes),
    ),
    externalChunks,
  }
}

export const decodeMinecraftRegionFiles = (
  regionBytes: Uint8Array,
  externalChunks: ReadonlyArray<MinecraftExternalChunkFile>,
  options?: MinecraftRegionFilesOptions,
): AnvilRegion => {
  const region = decodeAnvilRegion(regionBytes, regionOptions(options?.maxRegionBytes))
  if (!Array.isArray(externalChunks)) throw regionFilesError('externalChunks must be an array')
  const records = new Map<number, Uint8Array>()
  for (const file of externalChunks) {
    if (file === null || typeof file !== 'object') throw regionFilesError('external chunk file must be an object')
    const key = externalFileKey(file.localX, file.localZ)
    if (records.has(key)) throw regionFilesError(`duplicate external chunk coordinates ${String(file.localX)},${String(file.localZ)}`)
    records.set(key, decodeMinecraftExternalChunkFile(file.bytes, externalOptions(options?.maxExternalBytes)))
  }

  const chunks: Array<AnvilChunkRecord | null> = region.chunks.map((chunk, index) => {
    if (chunk === null || chunk.external !== true) {
      if (records.has(index)) throw regionFilesError(`external chunk has no matching region stub at slot ${String(index)}`)
      return chunk
    }
    const payload = records.get(index)
    if (payload === undefined) throw regionFilesError(`region stub at slot ${String(index)} has no external chunk file`)
    return { ...chunk, payload }
  })
  return anvilRegion(chunks, region.timestamps)
}
