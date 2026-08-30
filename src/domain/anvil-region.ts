/* oxlint-disable no-bitwise -- Anvil location entries are three-byte big-endian values. */

import { Data } from 'effect'
import { assertDefined } from './assert-defined.js'

export const ANVIL_SECTOR_BYTES = 4096
export const ANVIL_HEADER_SECTORS = 2
export const ANVIL_HEADER_BYTES = ANVIL_HEADER_SECTORS * ANVIL_SECTOR_BYTES
export const ANVIL_REGION_CHUNK_SIDE = 32
export const ANVIL_CHUNK_COUNT = ANVIL_REGION_CHUNK_SIDE * ANVIL_REGION_CHUNK_SIDE
export const ANVIL_MAX_CHUNK_SECTORS = 0xff
export const ANVIL_MAX_REGION_BYTES =
  (ANVIL_HEADER_SECTORS + ANVIL_CHUNK_COUNT * ANVIL_MAX_CHUNK_SECTORS) * ANVIL_SECTOR_BYTES
export const ANVIL_EXTERNAL_STREAM_FLAG = 0x80
export const ANVIL_EXTERNAL_CHUNK_THRESHOLD = 256
export const ANVIL_EXTERNAL_FILE_EXTENSION = '.mcc'

export const ANVIL_COMPRESSION_IDS = {
  gzip: 1,
  zlib: 2,
  none: 3,
  lz4: 4,
  custom: 127,
} as const

export type AnvilCompression = keyof typeof ANVIL_COMPRESSION_IDS

export class AnvilRegionError extends Data.TaggedError('AnvilRegionError')<{
  readonly reason: string
  readonly offset?: number
}> {
  override get message(): string {
    return this.offset === undefined
      ? `Anvil region is invalid: ${this.reason}`
      : `Anvil region is invalid at byte offset ${String(this.offset)}: ${this.reason}`
  }
}

export type AnvilChunkRecord = {
  readonly localX: number
  readonly localZ: number
  readonly timestamp: number
  readonly compression: AnvilCompression
  readonly payload: Uint8Array
  readonly external?: boolean
}

export type AnvilRegion = {
  readonly chunks: ReadonlyArray<AnvilChunkRecord | null>
  readonly timestamps: ReadonlyArray<number>
}

export type AnvilRegionOptions = {
  readonly maxBytes?: number
}

const regionError = (reason: string, offset?: number): AnvilRegionError =>
  new AnvilRegionError({ reason, ...(offset === undefined ? {} : { offset }) })

const asArrayBuffer = (buffer: ArrayBufferLike): ArrayBuffer => {
  if (!(buffer instanceof ArrayBuffer)) throw regionError('expected an ArrayBuffer-backed Uint8Array')
  return buffer
}

const resolveMaxBytes = (maxBytes: number | undefined): number => {
  const resolved = maxBytes ?? ANVIL_MAX_REGION_BYTES
  if (!Number.isSafeInteger(resolved) || resolved < ANVIL_HEADER_BYTES || resolved > ANVIL_MAX_REGION_BYTES) {
    throw regionError(
      `maxBytes must be a safe integer between ${String(ANVIL_HEADER_BYTES)} and ${String(ANVIL_MAX_REGION_BYTES)}`,
    )
  }
  return resolved
}

const isCompression = (value: unknown): value is AnvilCompression =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(ANVIL_COMPRESSION_IDS, value)

export const anvilCompressionFromId = (id: number): AnvilCompression | undefined => {
  switch (id) {
    case ANVIL_COMPRESSION_IDS.gzip:
      return 'gzip'
    case ANVIL_COMPRESSION_IDS.zlib:
      return 'zlib'
    case ANVIL_COMPRESSION_IDS.none:
      return 'none'
    case ANVIL_COMPRESSION_IDS.lz4:
      return 'lz4'
    case ANVIL_COMPRESSION_IDS.custom:
      return 'custom'
    default:
      return undefined
  }
}

export const anvilCompressionId = (compression: AnvilCompression): number => ANVIL_COMPRESSION_IDS[compression]

const assertTimestamp = (timestamp: number): void => {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
    throw regionError('timestamp must be an unsigned 32-bit integer')
  }
}

const assertChunk = (chunk: AnvilChunkRecord, index: number): void => {
  if (chunk === null || typeof chunk !== 'object') throw regionError(`chunk ${String(index)} must be an object`)
  if (!Number.isInteger(chunk.localX) || chunk.localX < 0 || chunk.localX >= ANVIL_REGION_CHUNK_SIDE) {
    throw regionError(`chunk ${String(index)} has an invalid localX`)
  }
  if (!Number.isInteger(chunk.localZ) || chunk.localZ < 0 || chunk.localZ >= ANVIL_REGION_CHUNK_SIDE) {
    throw regionError(`chunk ${String(index)} has an invalid localZ`)
  }
  assertTimestamp(chunk.timestamp)
  if (!isCompression(chunk.compression)) throw regionError(`chunk ${String(index)} has an unknown compression type`)
  if (!(chunk.payload instanceof Uint8Array)) throw regionError(`chunk ${String(index)} payload must be a Uint8Array`)
  if (chunk.external !== undefined && typeof chunk.external !== 'boolean') {
    throw regionError(`chunk ${String(index)} external must be a boolean`)
  }
  const recordBytes = chunk.external === true ? 5 : 5 + chunk.payload.byteLength
  const sectors = Math.ceil(recordBytes / ANVIL_SECTOR_BYTES)
  if (sectors < 1 || sectors > ANVIL_MAX_CHUNK_SECTORS) {
    throw regionError(`chunk ${String(index)} payload does not fit in 255 sectors`)
  }
}

export const anvilRegion = (
  chunks: ReadonlyArray<AnvilChunkRecord | null>,
  timestamps?: ReadonlyArray<number>,
): AnvilRegion => {
  if (!Array.isArray(chunks)) throw regionError('chunks must be an array')
  if (chunks.length !== ANVIL_CHUNK_COUNT) {
    throw regionError(`region must contain exactly ${String(ANVIL_CHUNK_COUNT)} chunk slots`)
  }
  if (timestamps !== undefined && !Array.isArray(timestamps)) {
    throw regionError('timestamps must be an array')
  }
  if (timestamps !== undefined && timestamps.length !== ANVIL_CHUNK_COUNT) {
    throw regionError(`region must contain exactly ${String(ANVIL_CHUNK_COUNT)} timestamps`)
  }

  const copiedChunks: Array<AnvilChunkRecord | null> = []
  const copiedTimestamps: number[] = []
  for (let index = 0; index < ANVIL_CHUNK_COUNT; index += 1) {
    const chunk = chunks[index]
    if (chunk === null || chunk === undefined) {
      copiedChunks.push(null)
      const timestamp = timestamps?.[index] ?? 0
      assertTimestamp(timestamp)
      copiedTimestamps.push(timestamp)
      continue
    }
    assertChunk(chunk, index)
    const expectedLocalX = index % ANVIL_REGION_CHUNK_SIDE
    const expectedLocalZ = Math.floor(index / ANVIL_REGION_CHUNK_SIDE)
    if (chunk.localX !== expectedLocalX || chunk.localZ !== expectedLocalZ) {
      throw regionError(`chunk ${String(index)} local coordinates do not match its slot`)
    }
    const timestamp = timestamps?.[index] ?? chunk.timestamp
    assertTimestamp(timestamp)
    copiedChunks.push({ ...chunk, payload: chunk.payload.slice(), timestamp })
    copiedTimestamps.push(timestamp)
  }
  return { chunks: copiedChunks, timestamps: copiedTimestamps }
}

const readUint24 = (view: DataView, offset: number): number =>
  (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2)

const writeUint24 = (view: DataView, offset: number, value: number): void => {
  view.setUint8(offset, (value >> 16) & 0xff)
  view.setUint8(offset + 1, (value >> 8) & 0xff)
  view.setUint8(offset + 2, value & 0xff)
}

export const decodeAnvilRegion = (bytes: Uint8Array, options?: AnvilRegionOptions): AnvilRegion => {
  const maxBytes = resolveMaxBytes(options?.maxBytes)
  if (!(bytes instanceof Uint8Array)) throw regionError('input must be a Uint8Array')
  if (bytes.byteLength < ANVIL_HEADER_BYTES) throw regionError('region is smaller than its 8 KiB header')
  if (bytes.byteLength % ANVIL_SECTOR_BYTES !== 0) throw regionError('region length must be a multiple of 4096 bytes')
  if (bytes.byteLength > maxBytes) throw regionError(`region exceeds maxBytes ${String(maxBytes)}`)

  const sectorCount = bytes.byteLength / ANVIL_SECTOR_BYTES
  const view = new DataView(asArrayBuffer(bytes.buffer), bytes.byteOffset, bytes.byteLength)
  const timestamps: number[] = []
  const chunks: Array<AnvilChunkRecord | null> = new Array(ANVIL_CHUNK_COUNT).fill(null)
  const occupied = new Uint8Array(sectorCount)
  occupied.fill(1, 0, ANVIL_HEADER_SECTORS)

  for (let index = 0; index < ANVIL_CHUNK_COUNT; index += 1) {
    const headerOffset = index * 4
    const sectorOffset = readUint24(view, headerOffset)
    const sectorLength = view.getUint8(headerOffset + 3)
    const timestamp = view.getUint32(ANVIL_SECTOR_BYTES + headerOffset, false)
    timestamps.push(timestamp)

    if (sectorOffset === 0 && sectorLength === 0) continue
    if (sectorOffset < ANVIL_HEADER_SECTORS || sectorLength === 0) {
      throw regionError(`chunk slot ${String(index)} has an invalid location entry`, headerOffset)
    }
    if (sectorOffset > sectorCount - sectorLength) {
      throw regionError(`chunk slot ${String(index)} points beyond the region`, headerOffset)
    }
    for (let sector = sectorOffset; sector < sectorOffset + sectorLength; sector += 1) {
      if (occupied[sector] !== 0) throw regionError(`chunk slot ${String(index)} overlaps another allocation`, headerOffset)
      occupied[sector] = 1
    }

    const chunkOffset = sectorOffset * ANVIL_SECTOR_BYTES
    const allocatedBytes = sectorLength * ANVIL_SECTOR_BYTES
    const length = view.getUint32(chunkOffset, false)
    if (length < 1 || length > allocatedBytes - 4) {
      throw regionError(`chunk slot ${String(index)} has an invalid record length`, chunkOffset)
    }
    const compressionId = view.getUint8(chunkOffset + 4)
    const external = (compressionId & ANVIL_EXTERNAL_STREAM_FLAG) !== 0
    const compression = anvilCompressionFromId(compressionId & ~ANVIL_EXTERNAL_STREAM_FLAG)
    if (compression === undefined) {
      throw regionError(`chunk slot ${String(index)} has unknown compression id ${String(compressionId)}`, chunkOffset + 4)
    }
    if (external && length !== 1) {
      throw regionError(`chunk slot ${String(index)} has an invalid external stub length`, chunkOffset)
    }
    const payload = external ? new Uint8Array() : bytes.slice(chunkOffset + 5, chunkOffset + 4 + length)
    chunks[index] = {
      localX: index % ANVIL_REGION_CHUNK_SIDE,
      localZ: Math.floor(index / ANVIL_REGION_CHUNK_SIDE),
      timestamp,
      compression,
      payload,
      ...(external ? { external: true } : {}),
    }
  }

  return { chunks, timestamps }
}

export const encodeAnvilRegion = (region: AnvilRegion, options?: AnvilRegionOptions): Uint8Array => {
  const maxBytes = resolveMaxBytes(options?.maxBytes)
  if (region === null || typeof region !== 'object') throw regionError('region must be an object')
  if (!Array.isArray(region.chunks) || !Array.isArray(region.timestamps)) {
    throw regionError('region chunks and timestamps must be arrays')
  }
  if (region.chunks.length !== ANVIL_CHUNK_COUNT) {
    throw regionError(`region must contain exactly ${String(ANVIL_CHUNK_COUNT)} chunk slots`)
  }
  if (region.timestamps.length !== ANVIL_CHUNK_COUNT) {
    throw regionError(`region must contain exactly ${String(ANVIL_CHUNK_COUNT)} timestamps`)
  }

  let nextSector = ANVIL_HEADER_SECTORS
  const locations: Array<readonly [offset: number, sectors: number]> = []
  for (let index = 0; index < ANVIL_CHUNK_COUNT; index += 1) {
    const timestamp = region.timestamps[index]
    if (timestamp === undefined) throw regionError(`region timestamp ${String(index)} is missing`)
    assertTimestamp(timestamp)
    const chunk = region.chunks[index]
    if (chunk === null || chunk === undefined) {
      locations.push([0, 0])
      continue
    }
    assertChunk(chunk, index)
    if (chunk.external === true && chunk.payload.byteLength !== 0) {
      throw regionError(`chunk ${String(index)} external stubs cannot contain an inline payload`)
    }
    const expectedLocalX = index % ANVIL_REGION_CHUNK_SIDE
    const expectedLocalZ = Math.floor(index / ANVIL_REGION_CHUNK_SIDE)
    if (chunk.localX !== expectedLocalX || chunk.localZ !== expectedLocalZ) {
      throw regionError(`chunk ${String(index)} local coordinates do not match its slot`)
    }
    const sectors = Math.ceil((chunk.external === true ? 5 : 5 + chunk.payload.byteLength) / ANVIL_SECTOR_BYTES)
    locations.push([nextSector, sectors])
    nextSector += sectors
  }

  const totalBytes = nextSector * ANVIL_SECTOR_BYTES
  if (totalBytes > maxBytes) throw regionError(`encoded region exceeds maxBytes ${String(maxBytes)}`)
  const bytes = new Uint8Array(totalBytes)
  const view = new DataView(bytes.buffer)

  for (let index = 0; index < ANVIL_CHUNK_COUNT; index += 1) {
    const [sectorOffset, sectorLength] = assertDefined(locations[index], `location ${String(index)} is missing`)
    const headerOffset = index * 4
    writeUint24(view, headerOffset, sectorOffset)
    view.setUint8(headerOffset + 3, sectorLength)
    const timestamp = assertDefined(region.timestamps[index], `region timestamp ${String(index)} is missing`)
    view.setUint32(ANVIL_SECTOR_BYTES + headerOffset, timestamp, false)

    const chunk = region.chunks[index]
    if (chunk === null || chunk === undefined) continue
    const chunkOffset = sectorOffset * ANVIL_SECTOR_BYTES
    const recordLength = chunk.external === true ? 1 : 1 + chunk.payload.byteLength
    view.setUint32(chunkOffset, recordLength, false)
    view.setUint8(
      chunkOffset + 4,
      anvilCompressionId(chunk.compression) | (chunk.external === true ? ANVIL_EXTERNAL_STREAM_FLAG : 0),
    )
    if (chunk.external !== true) bytes.set(chunk.payload, chunkOffset + 5)
  }

  return bytes
}
