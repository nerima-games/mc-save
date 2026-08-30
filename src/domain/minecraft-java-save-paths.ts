import { ChunkAxis } from '@nerima-games/mc-kernel'
import { assertDefined } from './assert-defined.js'
import type { MinecraftDimension, MinecraftRegionStorage } from './minecraft-paths.js'

type KnownPlayerJsonCategory = 'stats' | 'advancements'

export type MinecraftJavaSavePath =
  | { readonly kind: 'level'; readonly path: string }
  | { readonly kind: 'levelBackup'; readonly path: string }
  | { readonly kind: 'sessionLock'; readonly path: string }
  | { readonly kind: 'icon'; readonly path: string }
  | { readonly kind: 'resourcePack'; readonly path: string }
  | { readonly kind: 'playerData'; readonly playerId: string; readonly path: string }
  | {
      readonly kind: 'playerJson'
      readonly category: KnownPlayerJsonCategory
      readonly playerId: string
      readonly path: string
    }
  | {
      readonly kind: 'region'
      readonly dimension: MinecraftDimension
      readonly storage: MinecraftRegionStorage
      readonly regionX: ReturnType<typeof ChunkAxis>
      readonly regionZ: ReturnType<typeof ChunkAxis>
      readonly path: string
    }
  | {
      readonly kind: 'externalChunk'
      readonly dimension: MinecraftDimension
      readonly storage: MinecraftRegionStorage
      readonly chunkX: ReturnType<typeof ChunkAxis>
      readonly chunkZ: ReturnType<typeof ChunkAxis>
      readonly path: string
    }
  | { readonly kind: 'worldClock'; readonly namespace: string; readonly id: string; readonly path: string }
  | {
      readonly kind: 'data'
      readonly dimension?: MinecraftDimension
      readonly namespace: string
      readonly name: string
      readonly path: string
    }
  | { readonly kind: 'structure'; readonly namespace: string; readonly name: string; readonly path: string }
  | { readonly kind: 'extra'; readonly path: string }

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u
const SAFE_DIMENSION_PART = /^[a-z0-9._-]+$/u
const REGION_FILE = /^r\.(-?(?:0|[1-9]\d*))\.(-?(?:0|[1-9]\d*))\.mca$/u
const EXTERNAL_CHUNK_FILE = /^c\.(-?(?:0|[1-9]\d*))\.(-?(?:0|[1-9]\d*))\.mcc$/u

const isSafeSegment = (value: string): boolean =>
  SAFE_SEGMENT.test(value) && value !== '.' && value !== '..'

const isSafeDimensionPart = (value: string): boolean =>
  SAFE_DIMENSION_PART.test(value) && value !== '.' && value !== '..'

const isSafeCoordinateText = (value: string): boolean => {
  // No separate INTEGER_COORDINATE regex re-check here: coordinate() below is only ever called with a
  // string already captured by REGION_FILE/EXTERNAL_CHUNK_FILE, whose capture group is exactly the
  // INTEGER_COORDINATE pattern, so it can never fail this same test again. The round-trip check alone
  // (Number.isSafeInteger plus the String(number) === value canonical-form check) is equally strict for
  // any input, including the ones the regex would have caught, so no coverage is lost by relying on it alone.
  const number = Number(value)
  return Number.isSafeInteger(number) && String(number) === value
}

const coordinate = (value: string, label: string): ReturnType<typeof ChunkAxis> => {
  if (!isSafeCoordinateText(value)) throw new TypeError(`${label} must be a canonical safe integer`)
  return ChunkAxis(Number(value))
}

const dimensionFromDirectory = (segments: ReadonlyArray<string>): MinecraftDimension | undefined => {
  if (segments.length < 3 || segments[0] !== 'dimensions') return undefined
  const namespace = segments[1]
  const path = segments.slice(2)
  if (namespace === undefined || path.length === 0 || !isSafeDimensionPart(namespace)) return undefined
  if (path.some((part) => !isSafeDimensionPart(part))) return undefined
  const identifier: `${string}:${string}` = `${namespace}:${path.join('/')}`
  if (identifier === 'minecraft:overworld') return 'overworld'
  if (identifier === 'minecraft:the_nether') return 'the_nether'
  if (identifier === 'minecraft:the_end') return 'the_end'
  return identifier
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

const parseRegion = (segments: ReadonlyArray<string>, path: string): MinecraftJavaSavePath | undefined => {
  if (segments.length < 5) return undefined
  const storage = storageAt(segments.at(-2))
  const file = segments.at(-1)
  if (storage === undefined || file === undefined) return undefined
  const dimension = dimensionFromDirectory(segments.slice(0, -2))
  if (dimension === undefined) return undefined
  const regionMatch = REGION_FILE.exec(file)
  if (regionMatch !== null) {
    // Both capture groups are mandatory (non-optional) in REGION_FILE, so a successful match always
    // populates them; the assertion just tells TypeScript what the regex already guarantees.
    const regionX = assertDefined(regionMatch[1], 'REGION_FILE matched without its region x capture group')
    const regionZ = assertDefined(regionMatch[2], 'REGION_FILE matched without its region z capture group')
    return {
      kind: 'region',
      dimension,
      storage,
      regionX: coordinate(regionX, 'region x'),
      regionZ: coordinate(regionZ, 'region z'),
      path,
    }
  }
  const externalMatch = EXTERNAL_CHUNK_FILE.exec(file)
  if (externalMatch === null) return undefined
  const chunkX = assertDefined(externalMatch[1], 'EXTERNAL_CHUNK_FILE matched without its chunk x capture group')
  const chunkZ = assertDefined(externalMatch[2], 'EXTERNAL_CHUNK_FILE matched without its chunk z capture group')
  return {
    kind: 'externalChunk',
    dimension,
    storage,
    chunkX: coordinate(chunkX, 'chunk x'),
    chunkZ: coordinate(chunkZ, 'chunk z'),
    path,
  }
}

const playerPath = (segments: ReadonlyArray<string>, path: string): MinecraftJavaSavePath | undefined => {
  if (segments.length !== 3 || segments[0] !== 'players') return undefined
  const category = segments[1]
  // segments.length === 3 above guarantees index 2 exists.
  const file = assertDefined(segments[2], 'playerPath: segments.length === 3 but index 2 is missing')
  if (category !== 'data' && category !== 'stats' && category !== 'advancements') return undefined
  if (!isSafeSegment(file)) return undefined
  const playerIdWithExtension = file
  const extension = category === 'data' ? '.dat' : '.json'
  if (!playerIdWithExtension.endsWith(extension)) return undefined
  const playerId = playerIdWithExtension.slice(0, -extension.length)
  if (!isSafeSegment(playerId)) return undefined
  if (category === 'data') return { kind: 'playerData', playerId, path }
  return {
    kind: 'playerJson',
    category,
    playerId,
    path,
  }
}

const dataPath = (segments: ReadonlyArray<string>, path: string): MinecraftJavaSavePath | undefined => {
  let dataIndex = -1
  let dimension: MinecraftDimension | undefined
  if (segments[0] === 'data') {
    dataIndex = 0
  } else if (segments[0] === 'dimensions') {
    for (let index = segments.length - 3; index >= 3; index -= 1) {
      if (segments[index] !== 'data') continue
      const candidate = dimensionFromDirectory(segments.slice(0, index))
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
  return dimension === undefined
    ? { kind: 'data', namespace, name: nameSegments.join('/'), path }
    : { kind: 'data', dimension, namespace, name: nameSegments.join('/'), path }
}

const worldClockPath = (segments: ReadonlyArray<string>, path: string): MinecraftJavaSavePath | undefined => {
  if (segments.length < 4 || segments[0] !== 'data' || segments[2] !== 'world_clock') return undefined
  const namespace = segments[1]
  const idSegments = segments.slice(3)
  const finalId = idSegments.at(-1)
  if (namespace === undefined || !isSafeSegment(namespace) || finalId === undefined) return undefined
  if (!finalId.endsWith('.json')) return undefined
  const id = finalId.slice(0, -5)
  if (!isSafeSegment(id) || idSegments.slice(0, -1).some((segment) => !isSafeSegment(segment))) return undefined
  return { kind: 'worldClock', namespace, id: [...idSegments.slice(0, -1), id].join('/'), path }
}

const structurePath = (segments: ReadonlyArray<string>, path: string): MinecraftJavaSavePath | undefined => {
  if (segments.length < 4 || segments[0] !== 'generated' || segments[2] !== 'structure') return undefined
  const namespace = segments[1]
  const nameSegments = segments.slice(3)
  const finalName = nameSegments.at(-1)
  if (namespace === undefined || !isSafeSegment(namespace) || finalName === undefined) return undefined
  if (!finalName.endsWith('.nbt')) return undefined
  const name = finalName.slice(0, -4)
  if (!isSafeSegment(name) || nameSegments.slice(0, -1).some((segment) => !isSafeSegment(segment))) return undefined
  return { kind: 'structure', namespace, name: [...nameSegments.slice(0, -1), name].join('/'), path }
}

export const parseMinecraftJavaSavePath = (path: string): MinecraftJavaSavePath => {
  const segments = path.split('/')
  if (path === 'level.dat') return { kind: 'level', path }
  if (path === 'level.dat_old') return { kind: 'levelBackup', path }
  if (path === 'session.lock') return { kind: 'sessionLock', path }
  if (path === 'icon.png') return { kind: 'icon', path }
  if (path === 'resourcepacks/resources.zip') return { kind: 'resourcePack', path }
  const player = playerPath(segments, path)
  if (player !== undefined) return player
  const region = parseRegion(segments, path)
  if (region !== undefined) return region
  const worldClock = worldClockPath(segments, path)
  if (worldClock !== undefined) return worldClock
  const data = dataPath(segments, path)
  if (data !== undefined) return data
  const structure = structurePath(segments, path)
  if (structure !== undefined) return structure
  return { kind: 'extra', path }
}
