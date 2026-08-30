import { CHUNK_SIZE_XZ, ChunkAxis, chunkCoord } from '@nerima-games/mc-kernel'
import type { ChunkCoord } from '@nerima-games/mc-kernel'
import { ANVIL_EXTERNAL_FILE_EXTENSION, ANVIL_REGION_CHUNK_SIDE } from './anvil-region.js'

export type MinecraftDimension = 'overworld' | 'the_nether' | 'the_end' | `${string}:${string}`
export type MinecraftRegionStorage = 'region' | 'entities' | 'poi'

const DIMENSION_IDENTIFIER_PART = /^[a-z0-9._-]+$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/
const MAP_ID = /^(?:0|[1-9]\d*)$/

const isSafeDimensionIdentifierPart = (value: string): boolean =>
  DIMENSION_IDENTIFIER_PART.test(value) && value !== '.' && value !== '..'

const pathSegment = (value: string, label: string): string => {
  if (!PATH_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${label} must be a single safe path segment`)
  }
  return value
}

const relativePath = (value: string, label: string): string => {
  const segments = value.split('/')
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`${label} must be a safe relative path`)
  }
  return segments.map((segment) => pathSegment(segment, label)).join('/')
}

const dimensionDirectoryForCustomIdentifier = (dimension: string): string | undefined => {
  const parts = dimension.split(':')
  if (parts.length !== 2) {
    return undefined
  }

  const namespace = parts[0]
  const path = parts[1]
  if (namespace === undefined || path === undefined || !isSafeDimensionIdentifierPart(namespace) || path.length === 0) {
    return undefined
  }

  const pathParts = path.split('/')
  if (pathParts.some((part) => !isSafeDimensionIdentifierPart(part))) {
    return undefined
  }

  return `dimensions/${namespace}/${path}`
}

const validatedChunkCoordinate = (coord: ChunkCoord): ChunkCoord => {
  if (coord === null || typeof coord !== 'object') {
    throw new TypeError('chunk coordinate must be an object')
  }

  try {
    return chunkCoord(coord.cx, coord.cz)
  } catch {
    throw new TypeError('chunk coordinate axes must be safe integers')
  }
}

export const minecraftDimensionDirectory = (dimension: MinecraftDimension): string => {
  switch (dimension) {
    case 'overworld':
      return 'dimensions/minecraft/overworld'
    case 'the_nether':
      return 'dimensions/minecraft/the_nether'
    case 'the_end':
      return 'dimensions/minecraft/the_end'
    default:
      break
  }

  if (dimension === 'minecraft:overworld') {
    return 'dimensions/minecraft/overworld'
  }
  if (dimension === 'minecraft:the_nether') {
    return 'dimensions/minecraft/the_nether'
  }
  if (dimension === 'minecraft:the_end') {
    return 'dimensions/minecraft/the_end'
  }

  const directory = dimensionDirectoryForCustomIdentifier(dimension)
  if (directory !== undefined) {
    return directory
  }

  throw new TypeError(`unsupported Minecraft dimension ${String(dimension)}`)
}

export const anvilRegionCoordinate = (coord: ChunkCoord): { readonly rx: ChunkAxis; readonly rz: ChunkAxis } => {
  const validated = validatedChunkCoordinate(coord)
  return {
    rx: ChunkAxis(Math.floor(validated.cx / ANVIL_REGION_CHUNK_SIDE)),
    rz: ChunkAxis(Math.floor(validated.cz / ANVIL_REGION_CHUNK_SIDE)),
  }
}

export const anvilChunkLocalCoordinate = (coord: ChunkCoord): { readonly x: number; readonly z: number } => {
  const validated = validatedChunkCoordinate(coord)
  return {
    x: ((validated.cx % ANVIL_REGION_CHUNK_SIDE) + ANVIL_REGION_CHUNK_SIDE) % ANVIL_REGION_CHUNK_SIDE,
    z: ((validated.cz % ANVIL_REGION_CHUNK_SIDE) + ANVIL_REGION_CHUNK_SIDE) % ANVIL_REGION_CHUNK_SIDE,
  }
}

export const anvilChunkIndex = (coord: ChunkCoord): number => {
  const local = anvilChunkLocalCoordinate(coord)
  return local.x + local.z * ANVIL_REGION_CHUNK_SIDE
}

export const anvilRegionFileName = (coord: ChunkCoord): string => {
  const region = anvilRegionCoordinate(coord)
  return `r.${String(region.rx)}.${String(region.rz)}.mca`
}

const minecraftRegionStorageDirectory = (storage: MinecraftRegionStorage): string => {
  switch (storage) {
    case 'region':
      return 'region'
    case 'entities':
      return 'entities'
    case 'poi':
      return 'poi'
    default:
      throw new TypeError(`unsupported Minecraft region storage ${String(storage)}`)
  }
}

export const minecraftRegionFilePath = (
  dimension: MinecraftDimension,
  coord: ChunkCoord,
  storage: MinecraftRegionStorage = 'region',
): string => {
  const directory = minecraftDimensionDirectory(dimension)
  const file = anvilRegionFileName(coord)
  const storageDirectory = minecraftRegionStorageDirectory(storage)
  return `${directory}/${storageDirectory}/${file}`
}

export const minecraftExternalChunkFileName = (coord: ChunkCoord): string => {
  const validated = validatedChunkCoordinate(coord)
  return `c.${String(validated.cx)}.${String(validated.cz)}${ANVIL_EXTERNAL_FILE_EXTENSION}`
}

export const minecraftExternalChunkFilePath = (
  dimension: MinecraftDimension,
  coord: ChunkCoord,
  storage: MinecraftRegionStorage = 'region',
): string => {
  const directory = minecraftDimensionDirectory(dimension)
  const storageDirectory = minecraftRegionStorageDirectory(storage)
  const file = minecraftExternalChunkFileName(coord)
  return `${directory}/${storageDirectory}/${file}`
}

export const minecraftLevelDataPath = (): string => 'level.dat'

export const minecraftLevelDataBackupPath = (): string => 'level.dat_old'

export const minecraftIconPath = (): string => 'icon.png'

export const minecraftSessionLockPath = (): string => 'session.lock'

export const minecraftPlayerDataPath = (playerId: string): string => `players/data/${pathSegment(playerId, 'player id')}.dat`

export const minecraftStatsPath = (playerId: string): string => `players/stats/${pathSegment(playerId, 'player id')}.json`

export const minecraftAdvancementsPath = (playerId: string): string =>
  `players/advancements/${pathSegment(playerId, 'player id')}.json`

export const minecraftDataFilePath = (
  namespace: string,
  name: string,
  dimension?: MinecraftDimension,
): string => {
  const dataDirectory = dimension === undefined ? 'data' : `${minecraftDimensionDirectory(dimension)}/data`
  return `${dataDirectory}/${pathSegment(namespace, 'data namespace')}/${relativePath(name, 'data file name')}`
}

export const minecraftCommandStoragePath = (namespace: string, dimension?: MinecraftDimension): string =>
  minecraftDataFilePath(namespace, 'command_storage.dat', dimension)

export const minecraftRaidsPath = (): string => minecraftDataFilePath('minecraft', 'raids.dat')

export const minecraftScoreboardPath = (): string => minecraftDataFilePath('minecraft', 'scoreboard.dat')

export const minecraftWorldBorderPath = (): string => minecraftDataFilePath('minecraft', 'world_border.dat')

export const minecraftEnderDragonFightPath = (): string =>
  minecraftDataFilePath('minecraft', 'ender_dragon_fight.dat', 'the_end')

export const minecraftWanderingTraderPath = (): string => minecraftDataFilePath('minecraft', 'wandering_trader.dat')

export const minecraftCustomBossEventsPath = (): string =>
  minecraftDataFilePath('minecraft', 'custom_boss_events.dat')

export const minecraftWeatherPath = (): string => minecraftDataFilePath('minecraft', 'weather.dat')

export const minecraftScheduledEventsPath = (): string => minecraftDataFilePath('minecraft', 'scheduled_events.dat')

export const minecraftGameRulesPath = (): string => minecraftDataFilePath('minecraft', 'game_rules.dat')

export const minecraftWorldGenSettingsPath = (): string => minecraftDataFilePath('minecraft', 'world_gen_settings.dat')

export const minecraftWorldClocksPath = (): string => minecraftDataFilePath('minecraft', 'world_clocks.dat')

export const minecraftWorldClockPath = (namespace: string, id: string): string =>
  `data/${pathSegment(namespace, 'world clock namespace')}/world_clock/${relativePath(id, 'world clock id')}.json`

export const minecraftMapFilePath = (mapId: number | string): string => {
  const name = typeof mapId === 'number' ? String(mapId) : mapId
  if (
    (typeof mapId === 'number' && (!Number.isSafeInteger(mapId) || mapId < 0)) ||
    (typeof mapId === 'string' && !MAP_ID.test(mapId))
  ) {
    throw new TypeError('map id must be a non-negative safe integer')
  }
  return `data/minecraft/maps/${name}.dat`
}

export const minecraftLastIdPath = (): string => 'data/minecraft/last_id.dat'

export const minecraftChunkTicketsPath = (): string => 'data/minecraft/chunk_tickets.dat'

export const minecraftWorldResourcePackPath = (): string => 'resourcepacks/resources.zip'

export const minecraftStructurePath = (namespace: string, structure: string): string =>
  `generated/${pathSegment(namespace, 'structure namespace')}/structure/${relativePath(structure, 'structure name')}.nbt`

export const ANVIL_REGION_BLOCK_SIDE = CHUNK_SIZE_XZ * ANVIL_REGION_CHUNK_SIDE
