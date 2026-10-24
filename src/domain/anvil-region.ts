/* oxlint-disable no-bitwise -- Anvil location entries are three-byte big-endian values. */

import { Data, Option, Result } from 'effect'
import type * as Cause from 'effect/Cause'

export const ANVIL_SECTOR_BYTES = 4096
export const ANVIL_HEADER_SECTORS = 2
export const ANVIL_HEADER_BYTES: number = ANVIL_HEADER_SECTORS * ANVIL_SECTOR_BYTES
export const ANVIL_REGION_CHUNK_SIDE = 32
export const ANVIL_CHUNK_COUNT: number = ANVIL_REGION_CHUNK_SIDE * ANVIL_REGION_CHUNK_SIDE
export const ANVIL_MAX_CHUNK_SECTORS = 0xff
export const ANVIL_MAX_REGION_BYTES: number =
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

type AnvilRegionErrorFields = {
  readonly reason: string
  readonly offset?: number
}

const AnvilRegionErrorBase: new (
  args: AnvilRegionErrorFields,
) => Cause.YieldableError & { readonly _tag: 'AnvilRegionError' } & Readonly<AnvilRegionErrorFields> =
  Data.TaggedError('AnvilRegionError')

export class AnvilRegionError extends AnvilRegionErrorBase {
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

const asArrayBuffer = (buffer: ArrayBufferLike): Result.Result<ArrayBuffer, AnvilRegionError> =>
  buffer instanceof ArrayBuffer
    ? Result.succeed(buffer)
    : Result.fail(regionError('expected an ArrayBuffer-backed Uint8Array'))

const resolveMaxBytes = (maxBytes: number | undefined): Result.Result<number, AnvilRegionError> => {
  const resolved = maxBytes ?? ANVIL_MAX_REGION_BYTES
  if (!Number.isSafeInteger(resolved) || resolved < ANVIL_HEADER_BYTES || resolved > ANVIL_MAX_REGION_BYTES) {
    return Result.fail(
      regionError(
        `maxBytes must be a safe integer between ${String(ANVIL_HEADER_BYTES)} and ${String(ANVIL_MAX_REGION_BYTES)}`,
      ),
    )
  }
  return Result.succeed(resolved)
}

const isCompression = (value: unknown): value is AnvilCompression =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(ANVIL_COMPRESSION_IDS, value)

export const anvilCompressionFromId = (id: number): Option.Option<AnvilCompression> => {
  switch (id) {
    case ANVIL_COMPRESSION_IDS.gzip:
      return Option.some('gzip')
    case ANVIL_COMPRESSION_IDS.zlib:
      return Option.some('zlib')
    case ANVIL_COMPRESSION_IDS.none:
      return Option.some('none')
    case ANVIL_COMPRESSION_IDS.lz4:
      return Option.some('lz4')
    case ANVIL_COMPRESSION_IDS.custom:
      return Option.some('custom')
    default:
      return Option.none()
  }
}

export const anvilCompressionId = (
  compression: AnvilCompression,
): Result.Result<number, AnvilRegionError> =>
  isCompression(compression)
    ? Result.succeed(ANVIL_COMPRESSION_IDS[compression])
    : Result.fail(regionError('unknown compression type'))

const assertTimestamp = (timestamp: unknown): Result.Result<number, AnvilRegionError> =>
  typeof timestamp === 'number' && Number.isInteger(timestamp) && timestamp >= 0 && timestamp <= 0xffffffff
    ? Result.succeed(timestamp)
    : Result.fail(regionError('timestamp must be an unsigned 32-bit integer'))

const assertChunk = (value: unknown, index: number): Result.Result<AnvilChunkRecord, AnvilRegionError> => {
  if (value === null || typeof value !== 'object') return Result.fail(regionError(`chunk ${String(index)} must be an object`))
  return Result.gen(function* () {
    const snapshot: {
      localX: unknown
      localZ: unknown
      timestamp: unknown
      compression: unknown
      payload: unknown
      external: unknown
    } = yield* Result.try({
      try: () => ({
        localX: Reflect.get(value, 'localX'),
        localZ: Reflect.get(value, 'localZ'),
        timestamp: Reflect.get(value, 'timestamp'),
        compression: Reflect.get(value, 'compression'),
        payload: Reflect.get(value, 'payload'),
        external: Reflect.get(value, 'external'),
      }),
      catch: () => regionError(`chunk ${String(index)} must be an object`),
    })
    if (
      typeof snapshot.localX !== 'number' ||
      !Number.isInteger(snapshot.localX) ||
      snapshot.localX < 0 ||
      snapshot.localX >= ANVIL_REGION_CHUNK_SIDE
    ) {
      return yield* Result.fail(regionError(`chunk ${String(index)} has an invalid localX`))
    }
    if (
      typeof snapshot.localZ !== 'number' ||
      !Number.isInteger(snapshot.localZ) ||
      snapshot.localZ < 0 ||
      snapshot.localZ >= ANVIL_REGION_CHUNK_SIDE
    ) {
      return yield* Result.fail(regionError(`chunk ${String(index)} has an invalid localZ`))
    }
    const timestamp = yield* assertTimestamp(snapshot.timestamp)
    if (!isCompression(snapshot.compression)) {
      return yield* Result.fail(regionError(`chunk ${String(index)} has an unknown compression type`))
    }
    const payloadValue = snapshot.payload
    if (!(payloadValue instanceof Uint8Array)) {
      return yield* Result.fail(regionError(`chunk ${String(index)} payload must be a Uint8Array`))
    }
    if (snapshot.external !== undefined && typeof snapshot.external !== 'boolean') {
      return yield* Result.fail(regionError(`chunk ${String(index)} external must be a boolean`))
    }
    const payload = yield* Result.try({
      try: () => payloadValue.slice(),
      catch: () => regionError(`chunk ${String(index)} payload could not be copied`),
    })
    const recordBytes = snapshot.external === true ? 5 : 5 + payload.byteLength
    const sectors = Math.ceil(recordBytes / ANVIL_SECTOR_BYTES)
    if (sectors < 1 || sectors > ANVIL_MAX_CHUNK_SECTORS) {
      return yield* Result.fail(regionError(`chunk ${String(index)} payload does not fit in 255 sectors`))
    }
    return {
      localX: snapshot.localX,
      localZ: snapshot.localZ,
      timestamp,
      compression: snapshot.compression,
      payload,
      ...(snapshot.external === undefined ? {} : { external: snapshot.external }),
    }
  })
}

const snapshotArray = (
  value: unknown,
  label: string,
): Result.Result<ReadonlyArray<unknown>, AnvilRegionError> => {
  if (!Array.isArray(value)) return Result.fail(regionError(`${label} must be an array`))
  return Result.try({
    try: () => {
      const length: number = value.length
      const items: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        items.push(value[index])
      }
      return items
    },
    catch: () => regionError(`${label} must be a readable array`),
  })
}

export const anvilRegion = (
  chunks: unknown,
  timestamps?: unknown,
): Result.Result<AnvilRegion, AnvilRegionError> =>
  Result.gen(function* () {
    const chunkValues = yield* snapshotArray(chunks, 'chunks')
    if (chunkValues.length !== ANVIL_CHUNK_COUNT) {
      return yield* Result.fail(regionError(`region must contain exactly ${String(ANVIL_CHUNK_COUNT)} chunk slots`))
    }
    const timestampValues =
      timestamps === undefined ? undefined : yield* snapshotArray(timestamps, 'timestamps')
    if (timestampValues !== undefined && timestampValues.length !== ANVIL_CHUNK_COUNT) {
      return yield* Result.fail(regionError(`region must contain exactly ${String(ANVIL_CHUNK_COUNT)} timestamps`))
    }

    const copiedChunks: Array<AnvilChunkRecord | null> = []
    const copiedTimestamps: number[] = []
    for (let index = 0; index < ANVIL_CHUNK_COUNT; index += 1) {
      const chunkValue = chunkValues[index]
      if (chunkValue === undefined) {
        return yield* Result.fail(regionError(`chunk ${String(index)} is missing`))
      }
      if (chunkValue === null) {
        copiedChunks.push(null)
        const timestampValue = timestampValues?.[index]
        const timestamp = yield* assertTimestamp(timestampValue === undefined && timestampValues === undefined ? 0 : timestampValue)
        copiedTimestamps.push(timestamp)
        continue
      }
      const chunk = yield* assertChunk(chunkValue, index)
      const expectedLocalX = index % ANVIL_REGION_CHUNK_SIDE
      const expectedLocalZ = Math.floor(index / ANVIL_REGION_CHUNK_SIDE)
      if (chunk.localX !== expectedLocalX || chunk.localZ !== expectedLocalZ) {
        return yield* Result.fail(regionError(`chunk ${String(index)} local coordinates do not match its slot`))
      }
      const timestampValue = timestampValues?.[index]
      const timestamp = yield* assertTimestamp(timestampValue === undefined && timestampValues === undefined ? chunk.timestamp : timestampValue)
      copiedChunks.push({ ...chunk, payload: chunk.payload.slice(), timestamp })
      copiedTimestamps.push(timestamp)
    }
    return { chunks: copiedChunks, timestamps: copiedTimestamps }
  })

const readUint24 = (view: DataView, offset: number): number =>
  (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2)

const writeUint24 = (view: DataView, offset: number, value: number): void => {
  view.setUint8(offset, (value >> 16) & 0xff)
  view.setUint8(offset + 1, (value >> 8) & 0xff)
  view.setUint8(offset + 2, value & 0xff)
}

export const decodeAnvilRegion = (
  bytes: Uint8Array,
  options?: AnvilRegionOptions,
): Result.Result<AnvilRegion, AnvilRegionError> =>
  Result.gen(function* () {
    if (!(bytes instanceof Uint8Array)) {
      return yield* Result.fail(regionError('input must be a Uint8Array'))
    }
    const input = yield* Result.try({
      try: () => ({
        buffer: bytes.buffer,
        byteOffset: bytes.byteOffset,
        byteLength: bytes.byteLength,
      }),
      catch: () => regionError('input must be a readable Uint8Array'),
    })
    const optionMaxBytes = yield* Result.try({
      try: () => options?.maxBytes,
      catch: () => regionError('maxBytes option must be readable'),
    })
    const maxBytes = yield* resolveMaxBytes(optionMaxBytes)
    if (input.byteLength < ANVIL_HEADER_BYTES) {
      return yield* Result.fail(regionError('region is smaller than its 8 KiB header'))
    }
    if (input.byteLength % ANVIL_SECTOR_BYTES !== 0) {
      return yield* Result.fail(regionError('region length must be a multiple of 4096 bytes'))
    }
    if (input.byteLength > maxBytes) {
      return yield* Result.fail(regionError(`region exceeds maxBytes ${String(maxBytes)}`))
    }

    const arrayBuffer = yield* asArrayBuffer(input.buffer)
    const view = yield* Result.try({
      try: () => new DataView(arrayBuffer, input.byteOffset, input.byteLength),
      catch: () => regionError('input buffer is detached or out of bounds'),
    })
    const sectorCount = input.byteLength / ANVIL_SECTOR_BYTES
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
        return yield* Result.fail(
          regionError(`chunk slot ${String(index)} has an invalid location entry`, headerOffset),
        )
      }
      if (sectorOffset > sectorCount - sectorLength) {
        return yield* Result.fail(regionError(`chunk slot ${String(index)} points beyond the region`, headerOffset))
      }
      for (let sector = sectorOffset; sector < sectorOffset + sectorLength; sector += 1) {
        if (occupied[sector] !== 0) {
          return yield* Result.fail(
            regionError(`chunk slot ${String(index)} overlaps another allocation`, headerOffset),
          )
        }
        occupied[sector] = 1
      }

      const chunkOffset = sectorOffset * ANVIL_SECTOR_BYTES
      const allocatedBytes = sectorLength * ANVIL_SECTOR_BYTES
      const length = view.getUint32(chunkOffset, false)
      if (length < 1 || length > allocatedBytes - 4) {
        return yield* Result.fail(regionError(`chunk slot ${String(index)} has an invalid record length`, chunkOffset))
      }
      const compressionId = view.getUint8(chunkOffset + 4)
      const external = (compressionId & ANVIL_EXTERNAL_STREAM_FLAG) !== 0
      const compressionOption = anvilCompressionFromId(compressionId & ~ANVIL_EXTERNAL_STREAM_FLAG)
      if (Option.isNone(compressionOption)) {
        return yield* Result.fail(
          regionError(`chunk slot ${String(index)} has unknown compression id ${String(compressionId)}`, chunkOffset + 4),
        )
      }
      if (external && length !== 1) {
        return yield* Result.fail(regionError(`chunk slot ${String(index)} has an invalid external stub length`, chunkOffset))
      }
      const payload = external
        ? new Uint8Array()
        : new Uint8Array(
            arrayBuffer,
            input.byteOffset + chunkOffset + 5,
            length - 1,
          ).slice()
      chunks[index] = {
        localX: index % ANVIL_REGION_CHUNK_SIDE,
        localZ: Math.floor(index / ANVIL_REGION_CHUNK_SIDE),
        timestamp,
        compression: compressionOption.value,
        payload,
        ...(external ? { external: true } : {}),
      }
    }

    return { chunks, timestamps }
  })

export const encodeAnvilRegion = (
  region: AnvilRegion,
  options?: AnvilRegionOptions,
): Result.Result<Uint8Array, AnvilRegionError> =>
  Result.gen(function* () {
    if (region === null || typeof region !== 'object') {
      return yield* Result.fail(regionError('region must be an object'))
    }
    const parts = yield* Result.try({
      try: () => ({ chunks: region.chunks, timestamps: region.timestamps }),
      catch: () => regionError('region chunks and timestamps must be readable'),
    })
    const validated = yield* anvilRegion(parts.chunks, parts.timestamps)
    const optionMaxBytes = yield* Result.try({
      try: () => options?.maxBytes,
      catch: () => regionError('maxBytes option must be readable'),
    })
    const maxBytes = yield* resolveMaxBytes(optionMaxBytes)

    let nextSector = ANVIL_HEADER_SECTORS
    const locations: Array<readonly [offset: number, sectors: number, chunk: AnvilChunkRecord | null]> = []
    for (const [index, chunk] of validated.chunks.entries()) {
      if (chunk === null) {
        locations.push([0, 0, null])
        continue
      }
      if (chunk.external === true && chunk.payload.byteLength !== 0) {
        return yield* Result.fail(
          regionError(`chunk ${String(index)} external stubs cannot contain an inline payload`),
        )
      }
      const sectors = Math.ceil((chunk.external === true ? 5 : 5 + chunk.payload.byteLength) / ANVIL_SECTOR_BYTES)
      locations.push([nextSector, sectors, chunk])
      nextSector += sectors
    }

    const totalBytes = nextSector * ANVIL_SECTOR_BYTES
    if (totalBytes > maxBytes) {
      return yield* Result.fail(regionError(`encoded region exceeds maxBytes ${String(maxBytes)}`))
    }
    const bytes = new Uint8Array(totalBytes)
    const view = new DataView(bytes.buffer)

    for (const [index, timestamp] of validated.timestamps.entries()) {
      view.setUint32(ANVIL_SECTOR_BYTES + index * 4, timestamp, false)
    }
    for (const [index, [sectorOffset, sectorLength, chunk]] of locations.entries()) {
      const headerOffset = index * 4
      writeUint24(view, headerOffset, sectorOffset)
      view.setUint8(headerOffset + 3, sectorLength)

      if (chunk === null) continue
      const chunkOffset = sectorOffset * ANVIL_SECTOR_BYTES
      const recordLength = chunk.external === true ? 1 : 1 + chunk.payload.byteLength
      const compressionId = yield* anvilCompressionId(chunk.compression)
      view.setUint32(chunkOffset, recordLength, false)
      view.setUint8(
        chunkOffset + 4,
        compressionId | (chunk.external === true ? ANVIL_EXTERNAL_STREAM_FLAG : 0),
      )
      if (chunk.external !== true) bytes.set(chunk.payload, chunkOffset + 5)
    }

    return bytes
  })
