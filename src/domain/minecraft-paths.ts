import { ChunkAxis, chunkCoord, CHUNK_SIZE_XZ } from '@nerima-games/mc-kernel/domain/coordinates'
import type { ChunkCoord } from '@nerima-games/mc-kernel/domain/coordinates'
import { Result } from 'effect'
import { ANVIL_EXTERNAL_FILE_EXTENSION, ANVIL_REGION_CHUNK_SIDE } from './anvil-region.js'

export type MinecraftDimension = 'overworld' | 'the_nether' | 'the_end' | `${string}:${string}`
export type MinecraftRegionStorage = 'region' | 'entities' | 'poi'

const DIMENSION_IDENTIFIER_PART = /^[a-z0-9._-]+$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/
const MAP_ID = /^(?:0|[1-9]\d*)$/

const isSafeDimensionIdentifierPart = (value: string): boolean =>
  DIMENSION_IDENTIFIER_PART.test(value) && value !== '.' && value !== '..'

const pathSegment = (value: string, label: string): Result.Result<string, TypeError> => {
  if (!PATH_SEGMENT.test(value) || value === '.' || value === '..') {
    return Result.fail(new TypeError(`${label} must be a single safe path segment`))
  }
  return Result.succeed(value)
}

const relativePath = (value: string, label: string): Result.Result<string, TypeError> =>
  Result.gen(function* () {
    const segments = value.split('/')
    if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
      return yield* Result.fail(new TypeError(`${label} must be a safe relative path`))
    }
    const validated: string[] = []
    for (const segment of segments) {
      validated.push(yield* pathSegment(segment, label))
    }
    return validated.join('/')
  })

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

const validatedChunkCoordinate = (coord: ChunkCoord): Result.Result<ChunkCoord, TypeError> => {
  if (coord === null || typeof coord !== 'object') {
    return Result.fail(new TypeError('chunk coordinate must be an object'))
  }

  return Result.gen(function* () {
    const axes = yield* Result.try({
      try: () => ({ cx: coord.cx, cz: coord.cz }),
      catch: () => new TypeError('chunk coordinate must be an object'),
    })
    const cx = yield* Result.mapError(
      ChunkAxis.result(axes.cx),
      () => new TypeError('chunk coordinate axes must be safe integers'),
    )
    const cz = yield* Result.mapError(
      ChunkAxis.result(axes.cz),
      () => new TypeError('chunk coordinate axes must be safe integers'),
    )
    return chunkCoord(cx, cz)
  })
}

export const minecraftDimensionDirectory = (
  dimension: string,
): Result.Result<string, TypeError> => {
  switch (dimension) {
    case 'overworld':
    case 'minecraft:overworld':
      return Result.succeed('dimensions/minecraft/overworld')
    case 'the_nether':
    case 'minecraft:the_nether':
      return Result.succeed('dimensions/minecraft/the_nether')
    case 'the_end':
    case 'minecraft:the_end':
      return Result.succeed('dimensions/minecraft/the_end')
    default: {
      const directory = dimensionDirectoryForCustomIdentifier(dimension)
      return directory === undefined
        ? Result.fail(new TypeError(`unsupported Minecraft dimension ${String(dimension)}`))
        : Result.succeed(directory)
    }
  }
}

export const anvilRegionCoordinate = (
  coord: ChunkCoord,
): Result.Result<{ readonly rx: ChunkAxis; readonly rz: ChunkAxis }, TypeError> =>
  Result.gen(function* () {
    const validated = yield* validatedChunkCoordinate(coord)
    // Flooring a validated safe integer by the region side stays within safe integers.
    const rx = ChunkAxis(Math.floor(validated.cx / ANVIL_REGION_CHUNK_SIDE))
    const rz = ChunkAxis(Math.floor(validated.cz / ANVIL_REGION_CHUNK_SIDE))
    return { rx, rz }
  })

export const anvilChunkLocalCoordinate = (
  coord: ChunkCoord,
): Result.Result<{ readonly x: number; readonly z: number }, TypeError> =>
  Result.map(validatedChunkCoordinate(coord), (validated) => ({
    x: ((validated.cx % ANVIL_REGION_CHUNK_SIDE) + ANVIL_REGION_CHUNK_SIDE) % ANVIL_REGION_CHUNK_SIDE,
    z: ((validated.cz % ANVIL_REGION_CHUNK_SIDE) + ANVIL_REGION_CHUNK_SIDE) % ANVIL_REGION_CHUNK_SIDE,
  }))

export const anvilChunkIndex = (coord: ChunkCoord): Result.Result<number, TypeError> =>
  Result.map(anvilChunkLocalCoordinate(coord), (local) => local.x + local.z * ANVIL_REGION_CHUNK_SIDE)

export const anvilRegionFileName = (coord: ChunkCoord): Result.Result<string, TypeError> =>
  Result.map(anvilRegionCoordinate(coord), ({ rx, rz }) => `r.${String(rx)}.${String(rz)}.mca`)

const minecraftRegionStorageDirectory = (
  storage: MinecraftRegionStorage,
): Result.Result<string, TypeError> => {
  switch (storage) {
    case 'region':
    case 'entities':
    case 'poi':
      return Result.succeed(storage)
    default:
      return Result.fail(new TypeError(`unsupported Minecraft region storage ${String(storage)}`))
  }
}

export const minecraftRegionFilePath = (
  dimension: MinecraftDimension,
  coord: ChunkCoord,
  storage: MinecraftRegionStorage = 'region',
): Result.Result<string, TypeError> =>
  Result.gen(function* () {
    const directory = yield* minecraftDimensionDirectory(dimension)
    const storageDirectory = yield* minecraftRegionStorageDirectory(storage)
    const file = yield* anvilRegionFileName(coord)
    return `${directory}/${storageDirectory}/${file}`
  })

export const minecraftExternalChunkFileName = (
  coord: ChunkCoord,
): Result.Result<string, TypeError> =>
  Result.map(validatedChunkCoordinate(coord), (validated) =>
    `c.${String(validated.cx)}.${String(validated.cz)}${ANVIL_EXTERNAL_FILE_EXTENSION}`,
  )

export const minecraftExternalChunkFilePath = (
  dimension: MinecraftDimension,
  coord: ChunkCoord,
  storage: MinecraftRegionStorage = 'region',
): Result.Result<string, TypeError> =>
  Result.gen(function* () {
    const directory = yield* minecraftDimensionDirectory(dimension)
    const storageDirectory = yield* minecraftRegionStorageDirectory(storage)
    const file = yield* minecraftExternalChunkFileName(coord)
    return `${directory}/${storageDirectory}/${file}`
  })

export const minecraftLevelDataPath = (): string => 'level.dat'

export const minecraftLevelDataBackupPath = (): string => 'level.dat_old'

export const minecraftIconPath = (): string => 'icon.png'

export const minecraftSessionLockPath = (): string => 'session.lock'

export const minecraftPlayerDataPath = (playerId: string): Result.Result<string, TypeError> =>
  Result.map(pathSegment(playerId, 'player id'), (segment) => `players/data/${segment}.dat`)

export const minecraftStatsPath = (playerId: string): Result.Result<string, TypeError> =>
  Result.map(pathSegment(playerId, 'player id'), (segment) => `players/stats/${segment}.json`)

export const minecraftAdvancementsPath = (playerId: string): Result.Result<string, TypeError> =>
  Result.map(pathSegment(playerId, 'player id'), (segment) => `players/advancements/${segment}.json`)

export const minecraftDataFilePath = (
  namespace: string,
  name: string,
  dimension?: MinecraftDimension,
): Result.Result<string, TypeError> =>
  Result.gen(function* () {
    const dataDirectory =
      dimension === undefined
        ? 'data'
        : `${yield* minecraftDimensionDirectory(dimension)}/data`
    const validatedNamespace = yield* pathSegment(namespace, 'data namespace')
    const validatedName = yield* relativePath(name, 'data file name')
    return `${dataDirectory}/${validatedNamespace}/${validatedName}`
  })

export const minecraftCommandStoragePath = (
  namespace: string,
  dimension?: MinecraftDimension,
): Result.Result<string, TypeError> => minecraftDataFilePath(namespace, 'command_storage.dat', dimension)

export const minecraftRaidsPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'raids.dat')

export const minecraftScoreboardPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'scoreboard.dat')

export const minecraftWorldBorderPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'world_border.dat')

export const minecraftEnderDragonFightPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'ender_dragon_fight.dat', 'the_end')

export const minecraftWanderingTraderPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'wandering_trader.dat')

export const minecraftCustomBossEventsPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'custom_boss_events.dat')

export const minecraftWeatherPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'weather.dat')

export const minecraftScheduledEventsPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'scheduled_events.dat')

export const minecraftGameRulesPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'game_rules.dat')

export const minecraftWorldGenSettingsPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'world_gen_settings.dat')

export const minecraftWorldClocksPath = (): Result.Result<string, TypeError> =>
  minecraftDataFilePath('minecraft', 'world_clocks.dat')

export const minecraftWorldClockPath = (
  namespace: string,
  id: string,
): Result.Result<string, TypeError> =>
  Result.gen(function* () {
    const validatedNamespace = yield* pathSegment(namespace, 'world clock namespace')
    const validatedId = yield* relativePath(id, 'world clock id')
    return `data/${validatedNamespace}/world_clock/${validatedId}.json`
  })

export const minecraftMapFilePath = (mapId: number | string): Result.Result<string, TypeError> => {
  const name = typeof mapId === 'number' ? String(mapId) : mapId
  if (
    (typeof mapId === 'number' && (!Number.isSafeInteger(mapId) || mapId < 0)) ||
    (typeof mapId === 'string' && !MAP_ID.test(mapId))
  ) {
    return Result.fail(new TypeError('map id must be a non-negative safe integer'))
  }
  return Result.succeed(`data/minecraft/maps/${name}.dat`)
}

export const minecraftLastIdPath = (): string => 'data/minecraft/last_id.dat'

export const minecraftChunkTicketsPath = (): string => 'data/minecraft/chunk_tickets.dat'

export const minecraftWorldResourcePackPath = (): string => 'resourcepacks/resources.zip'

export const minecraftStructurePath = (
  namespace: string,
  structure: string,
): Result.Result<string, TypeError> =>
  Result.gen(function* () {
    const validatedNamespace = yield* pathSegment(namespace, 'structure namespace')
    const validatedName = yield* relativePath(structure, 'structure name')
    return `generated/${validatedNamespace}/structure/${validatedName}.nbt`
  })

export const ANVIL_REGION_BLOCK_SIDE: number = CHUNK_SIZE_XZ * ANVIL_REGION_CHUNK_SIDE
