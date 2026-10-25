import { ChunkAxis } from '@nerima-games/mc-kernel/domain/coordinates'
import { Brand, Result } from 'effect'
import {
  parseMinecraftDimension,
  parseMinecraftPathSegment,
  parseMinecraftRelativePath,
  type MinecraftDimension,
  type MinecraftPathSegment,
  type MinecraftRegionStorage,
  type MinecraftRelativePath,
} from './minecraft-paths.js'
import type { MinecraftJavaSaveFilePath } from './minecraft-java-save-types.js'

type KnownPlayerJsonCategory = 'stats' | 'advancements'

export type MinecraftJavaSavePath =
  | { readonly kind: 'level'; readonly path: MinecraftJavaSaveFilePath }
  | { readonly kind: 'levelBackup'; readonly path: MinecraftJavaSaveFilePath }
  | { readonly kind: 'sessionLock'; readonly path: MinecraftJavaSaveFilePath }
  | { readonly kind: 'icon'; readonly path: MinecraftJavaSaveFilePath }
  | { readonly kind: 'resourcePack'; readonly path: MinecraftJavaSaveFilePath }
  | { readonly kind: 'playerData'; readonly playerId: MinecraftPathSegment; readonly path: MinecraftJavaSaveFilePath }
  | {
      readonly kind: 'playerJson'
      readonly category: KnownPlayerJsonCategory
      readonly playerId: MinecraftPathSegment
      readonly path: MinecraftJavaSaveFilePath
    }
  | {
      readonly kind: 'region'
      readonly dimension: MinecraftDimension
      readonly storage: MinecraftRegionStorage
      readonly regionX: ReturnType<typeof ChunkAxis>
      readonly regionZ: ReturnType<typeof ChunkAxis>
      readonly path: MinecraftJavaSaveFilePath
    }
  | {
      readonly kind: 'externalChunk'
      readonly dimension: MinecraftDimension
      readonly storage: MinecraftRegionStorage
      readonly chunkX: ReturnType<typeof ChunkAxis>
      readonly chunkZ: ReturnType<typeof ChunkAxis>
      readonly path: MinecraftJavaSaveFilePath
    }
  | {
      readonly kind: 'worldClock'
      readonly namespace: MinecraftPathSegment
      readonly id: MinecraftRelativePath
      readonly path: MinecraftJavaSaveFilePath
    }
  | {
      readonly kind: 'data'
      readonly dimension?: MinecraftDimension
      readonly namespace: MinecraftPathSegment
      readonly name: MinecraftRelativePath
      readonly path: MinecraftJavaSaveFilePath
    }
  | {
      readonly kind: 'structure'
      readonly namespace: MinecraftPathSegment
      readonly name: MinecraftRelativePath
      readonly path: MinecraftJavaSaveFilePath
    }
  | { readonly kind: 'extra'; readonly path: MinecraftJavaSaveFilePath }

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u
const SAFE_DIMENSION_PART = /^[a-z0-9._-]+$/u
const REGION_FILE = /^r\.(-?(?:0|[1-9]\d*))\.(-?(?:0|[1-9]\d*))\.mca$/u
const EXTERNAL_CHUNK_FILE = /^c\.(-?(?:0|[1-9]\d*))\.(-?(?:0|[1-9]\d*))\.mcc$/u
const toMinecraftJavaSaveFilePath = Brand.make<MinecraftJavaSaveFilePath>((value) => {
  if (value.length === 0 || value.length > 4096) return 'save file path must contain at most 4096 characters'
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('\u0000')) {
    return 'save file path must be relative and use forward slashes'
  }
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') ||
    'save file path contains an unsafe path segment'
})

export const parseMinecraftJavaSaveFilePath = (
  value: unknown,
): Result.Result<MinecraftJavaSaveFilePath, TypeError> => {
  if (typeof value !== 'string') return Result.fail(new TypeError('save file path must be a string'))
  return Result.mapError(
    toMinecraftJavaSaveFilePath.result(value),
    () => new TypeError('save file path is invalid'),
  )
}

const isSafeSegment = (value: string): boolean =>
  SAFE_SEGMENT.test(value) && value !== '.' && value !== '..'

const isSafeDimensionPart = (value: string): boolean =>
  SAFE_DIMENSION_PART.test(value) && value !== '.' && value !== '..'

const isSafeCoordinateText = (value: string | undefined): boolean => {
  const number = Number(value)
  return Number.isSafeInteger(number) && String(number) === value
}

const coordinate = (
  value: string | undefined,
  label: string,
): Result.Result<ReturnType<typeof ChunkAxis>, TypeError> => {
  if (!isSafeCoordinateText(value)) {
    return Result.fail(new TypeError(`${label} must be a canonical safe integer`))
  }
  return Result.succeed(Brand.nominal<ReturnType<typeof ChunkAxis>>()(Number(value)))
}

const dimensionFromDirectory = (
  segments: ReadonlyArray<string>,
): Result.Result<MinecraftDimension | undefined, TypeError> => {
  if (segments.length < 3 || segments[0] !== 'dimensions') return Result.succeed(undefined)
  const namespace = segments[1]
  const path = segments.slice(2)
  if (namespace === undefined || path.length === 0 || !isSafeDimensionPart(namespace)) return Result.succeed(undefined)
  if (path.some((part) => !isSafeDimensionPart(part))) return Result.succeed(undefined)
  const identifier: `${string}:${string}` = `${namespace}:${path.join('/')}`
  return Result.map(parseMinecraftDimension(identifier), (dimension) => {
      switch (dimension) {
        case 'minecraft:overworld':
          return 'overworld'
        case 'minecraft:the_nether':
          return 'the_nether'
        case 'minecraft:the_end':
          return 'the_end'
        default:
          return dimension
      }
    },
  )
}

const storageAt = (value: string | undefined): MinecraftRegionStorage | undefined => {
  switch (value) {
    case 'region':
    case 'entities':
    case 'poi':
      return value
    default:
      return undefined
  }
}

const parseRegion = (
  segments: ReadonlyArray<string>,
  path: MinecraftJavaSaveFilePath,
): Result.Result<MinecraftJavaSavePath | undefined, TypeError> =>
  Result.gen(function* () {
    if (segments.length < 5) return undefined
    const storage = storageAt(segments.at(-2))
    const file = segments.at(-1)
    if (storage === undefined || file === undefined) return undefined
    const dimension = yield* dimensionFromDirectory(segments.slice(0, -2))
    if (dimension === undefined) return undefined

    const regionMatch = REGION_FILE.exec(file)
    if (regionMatch !== null) {
      const regionX = regionMatch[1]
      const regionZ = regionMatch[2]
      return {
        kind: 'region',
        dimension,
        storage,
        regionX: yield* coordinate(regionX, 'region x'),
        regionZ: yield* coordinate(regionZ, 'region z'),
        path,
      }
    }

    const externalMatch = EXTERNAL_CHUNK_FILE.exec(file)
    if (externalMatch === null) return undefined
    const chunkX = externalMatch[1]
    const chunkZ = externalMatch[2]
    return {
      kind: 'externalChunk',
      dimension,
      storage,
      chunkX: yield* coordinate(chunkX, 'chunk x'),
      chunkZ: yield* coordinate(chunkZ, 'chunk z'),
      path,
    }
  })

const playerPath = (
  segments: ReadonlyArray<string>,
  path: MinecraftJavaSaveFilePath,
): Result.Result<MinecraftJavaSavePath | undefined, TypeError> =>
  Result.gen(function* () {
    if (segments.length !== 3 || segments[0] !== 'players') return undefined
    const category = segments.slice(1, 2).join('')
    const file = segments.slice(2, 3).join('')
    if (category !== 'data' && category !== 'stats' && category !== 'advancements') return undefined
    if (!isSafeSegment(file)) return undefined
    const extension = category === 'data' ? '.dat' : '.json'
    if (!file.endsWith(extension)) return undefined
    const playerId = file.slice(0, -extension.length)
    if (!isSafeSegment(playerId)) return undefined
    const checkedPlayerId = yield* parseMinecraftPathSegment(playerId)
    if (category === 'data') return { kind: 'playerData', playerId: checkedPlayerId, path }
    return { kind: 'playerJson', category, playerId: checkedPlayerId, path }
  })

const dataPath = (
  segments: ReadonlyArray<string>,
  path: MinecraftJavaSaveFilePath,
): Result.Result<MinecraftJavaSavePath | undefined, TypeError> =>
  Result.gen(function* () {
    let dataIndex = -1
    let dimension: MinecraftDimension | undefined
    if (segments[0] === 'data') {
      dataIndex = 0
    } else if (segments[0] === 'dimensions') {
      for (let index = segments.length - 3; index >= 3; index -= 1) {
        if (segments[index] !== 'data') continue
        const candidate = yield* dimensionFromDirectory(segments.slice(0, index))
        if (candidate !== undefined) {
          dataIndex = index
          dimension = candidate
          break
        }
      }
    }
    if (dataIndex < 0 || segments.length < dataIndex + 3) return undefined
    const namespace = segments[dataIndex + 1]
    const nameSegments = segments.slice(dataIndex + 2)
    if (namespace === undefined || !isSafeSegment(namespace) || nameSegments.length === 0) return undefined
    if (nameSegments.some((segment) => !isSafeSegment(segment))) return undefined
    const checkedNamespace = yield* parseMinecraftPathSegment(namespace)
    const name = yield* parseMinecraftRelativePath(nameSegments.join('/'))
    return dimension === undefined
      ? { kind: 'data', namespace: checkedNamespace, name, path }
      : { kind: 'data', dimension, namespace: checkedNamespace, name, path }
  })

const worldClockPath = (
  segments: ReadonlyArray<string>,
  path: MinecraftJavaSaveFilePath,
): Result.Result<MinecraftJavaSavePath | undefined, TypeError> =>
  Result.gen(function* () {
    if (segments.length < 4 || segments[0] !== 'data' || segments[2] !== 'world_clock') return undefined
    const namespace = segments[1]
    const idSegments = segments.slice(3)
    const finalId = idSegments.at(-1)
    if (namespace === undefined || !isSafeSegment(namespace) || finalId === undefined) return undefined
    if (!finalId.endsWith('.json')) return undefined
    const id = finalId.slice(0, -5)
    if (!isSafeSegment(id) || idSegments.slice(0, -1).some((segment) => !isSafeSegment(segment))) return undefined
    const checkedNamespace = yield* parseMinecraftPathSegment(namespace)
    const checkedId = yield* parseMinecraftRelativePath([...idSegments.slice(0, -1), id].join('/'))
    return { kind: 'worldClock', namespace: checkedNamespace, id: checkedId, path }
  })

const structurePath = (
  segments: ReadonlyArray<string>,
  path: MinecraftJavaSaveFilePath,
): Result.Result<MinecraftJavaSavePath | undefined, TypeError> =>
  Result.gen(function* () {
    if (segments.length < 4 || segments[0] !== 'generated' || segments[2] !== 'structure') return undefined
    const namespace = segments[1]
    const nameSegments = segments.slice(3)
    const finalName = nameSegments.at(-1)
    if (namespace === undefined || !isSafeSegment(namespace) || finalName === undefined) return undefined
    if (!finalName.endsWith('.nbt')) return undefined
    const name = finalName.slice(0, -4)
    if (!isSafeSegment(name) || nameSegments.slice(0, -1).some((segment) => !isSafeSegment(segment))) return undefined
    const checkedNamespace = yield* parseMinecraftPathSegment(namespace)
    const checkedName = yield* parseMinecraftRelativePath([...nameSegments.slice(0, -1), name].join('/'))
    return { kind: 'structure', namespace: checkedNamespace, name: checkedName, path }
  })

export const parseMinecraftJavaSavePath = (
  value: unknown,
): Result.Result<MinecraftJavaSavePath, TypeError> =>
  Result.gen(function* () {
    const path = yield* parseMinecraftJavaSaveFilePath(value)
    const segments = path.split('/')
    if (path === 'level.dat') return { kind: 'level', path }
    if (path === 'level.dat_old') return { kind: 'levelBackup', path }
    if (path === 'session.lock') return { kind: 'sessionLock', path }
    if (path === 'icon.png') return { kind: 'icon', path }
    if (path === 'resourcepacks/resources.zip') return { kind: 'resourcePack', path }
    const player = yield* playerPath(segments, path)
    if (player !== undefined) return player
    const region = yield* parseRegion(segments, path)
    if (region !== undefined) return region
    const worldClock = yield* worldClockPath(segments, path)
    if (worldClock !== undefined) return worldClock
    const data = yield* dataPath(segments, path)
    if (data !== undefined) return data
    const structure = yield* structurePath(segments, path)
    if (structure !== undefined) return structure
    return { kind: 'extra', path }
  })
