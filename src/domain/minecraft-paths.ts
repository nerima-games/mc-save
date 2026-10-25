import { ChunkAxis, chunkCoord, CHUNK_SIZE_XZ } from '@nerima-games/mc-kernel/domain/coordinates'
import type { ChunkCoord } from '@nerima-games/mc-kernel/domain/coordinates'
import { Brand, Result } from 'effect'
import { ANVIL_EXTERNAL_FILE_EXTENSION, ANVIL_REGION_CHUNK_SIDE } from './anvil-region.js'

type OfficialMinecraftDimension =
  | 'overworld'
  | 'the_nether'
  | 'the_end'
  | 'minecraft:overworld'
  | 'minecraft:the_nether'
  | 'minecraft:the_end'
type CustomMinecraftDimension = string & Brand.Brand<'MinecraftDimension'>
export type MinecraftDimension = OfficialMinecraftDimension | CustomMinecraftDimension
export type MinecraftRegionStorage = 'region' | 'entities' | 'poi'
export type MinecraftPathSegment = string & Brand.Brand<'MinecraftPathSegment'>
export type MinecraftRelativePath = string & Brand.Brand<'MinecraftRelativePath'>
export type MinecraftSavePath = string & Brand.Brand<'MinecraftSavePath'>
export type MinecraftMapId = string & Brand.Brand<'MinecraftMapId'>
export type AnvilChunkLocalCoordinate = number & Brand.Brand<'AnvilChunkLocalCoordinate'>
export type AnvilChunkIndex = number & Brand.Brand<'AnvilChunkIndex'>
export type AnvilRegionBlockSide = number & Brand.Brand<'AnvilRegionBlockSide'>

const DIMENSION_IDENTIFIER_PART = /^[a-z0-9._-]+$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/
const MAP_ID = /^(?:0|[1-9]\d*)$/

const isSafeDimensionIdentifierPart = (value: string): boolean =>
  DIMENSION_IDENTIFIER_PART.test(value) && value !== '.' && value !== '..'
const isSafeMinecraftPathSegment = (value: string): boolean =>
  PATH_SEGMENT.test(value) && value !== '.' && value !== '..'
const isSafeMinecraftRelativePath = (value: string): boolean => {
  const segments = value.split('/')
  return segments.length > 0 && segments.every(isSafeMinecraftPathSegment)
}
const isSafeCustomMinecraftDimension = (value: string): boolean => {
  const parts = value.split(':')
  if (parts.length !== 2) return false
  const namespace = parts[0]
  const path = parts[1]
  return (
    namespace !== undefined &&
    path !== undefined &&
    isSafeDimensionIdentifierPart(namespace) &&
    path.split('/').every(isSafeDimensionIdentifierPart)
  )
}

const MinecraftPathSegmentBrand = Brand.make<MinecraftPathSegment>(isSafeMinecraftPathSegment)
const MinecraftRelativePathBrand = Brand.make<MinecraftRelativePath>(isSafeMinecraftRelativePath)
const MinecraftSavePathBrand = Brand.make<MinecraftSavePath>(isSafeMinecraftRelativePath)
const MinecraftMapIdBrand = Brand.make<MinecraftMapId>((value) => MAP_ID.test(value))
const CustomMinecraftDimensionBrand = Brand.make<CustomMinecraftDimension>(isSafeCustomMinecraftDimension)
const AnvilChunkLocalCoordinateBrand = Brand.make<AnvilChunkLocalCoordinate>(
  (value) => Number.isInteger(value) && value >= 0 && value < ANVIL_REGION_CHUNK_SIDE,
)
const AnvilChunkIndexBrand = Brand.make<AnvilChunkIndex>(
  (value) => Number.isInteger(value) && value >= 0 && value < ANVIL_REGION_CHUNK_SIDE ** 2,
)
const AnvilRegionBlockSideBrand = Brand.make<AnvilRegionBlockSide>(
  (value) => Number.isSafeInteger(value) && value > 0,
)

const invalidMinecraftMapId = (): TypeError => new TypeError('map id must be a non-negative safe integer')


export const parseMinecraftMapId = (value: unknown): Result.Result<MinecraftMapId, TypeError> => {
  let candidate: string
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return Result.fail(invalidMinecraftMapId())
    }
    candidate = String(value)
  } else if (typeof value === 'string') {
    candidate = value
  } else {
    return Result.fail(invalidMinecraftMapId())
  }
  return Result.mapError(MinecraftMapIdBrand.result(candidate), () => invalidMinecraftMapId())
}

const pathSegment = (value: unknown, label: string): Result.Result<MinecraftPathSegment, TypeError> => {
  if (typeof value !== 'string') {
    return Result.fail(new TypeError(`${label} must be a single safe path segment`))
  }
  return Result.mapError(
    MinecraftPathSegmentBrand.result(value),
    () => new TypeError(`${label} must be a single safe path segment`),
  )
}


export const parseMinecraftPathSegment = (
  value: unknown,
): Result.Result<MinecraftPathSegment, TypeError> => pathSegment(value, 'path segment')

const relativePath = (value: unknown, label: string): Result.Result<MinecraftRelativePath, TypeError> =>
  Result.gen(function* () {
    if (typeof value !== 'string') {
      return yield* Result.fail(new TypeError(`${label} must be a safe relative path`))
    }
    const segments = value.split('/')
    if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
      return yield* Result.fail(new TypeError(`${label} must be a safe relative path`))
    }
    for (const segment of segments) {
      yield* pathSegment(segment, label)
    }
    return Brand.nominal<MinecraftRelativePath>()(value)
  })


export const parseMinecraftRelativePath = (
  value: unknown,
): Result.Result<MinecraftRelativePath, TypeError> => relativePath(value, 'relative path')

const dimensionDirectoryForCustomIdentifier = (dimension: string): Result.Result<MinecraftSavePath, TypeError> =>
  Result.gen(function* () {
    const unsupported = (): TypeError => new TypeError(`unsupported Minecraft dimension ${dimension}`)
    const parts = dimension.split(':')
    if (parts.length !== 2) {
      return yield* Result.fail(unsupported())
    }

    const namespace = parts[0]
    const path = parts[1]
    if (namespace === undefined || path === undefined || !isSafeDimensionIdentifierPart(namespace) || path.length === 0) {
      return yield* Result.fail(unsupported())
    }

    const pathParts = path.split('/')
    if (pathParts.some((part) => !isSafeDimensionIdentifierPart(part))) {
      return yield* Result.fail(unsupported())
    }

    const validNamespace = yield* Result.mapError(MinecraftPathSegmentBrand.result(namespace), unsupported)
    const validPathParts: Array<MinecraftPathSegment> = []
    for (const part of pathParts) {
      validPathParts.push(yield* Result.mapError(MinecraftPathSegmentBrand.result(part), unsupported))
    }
    const pathValue = `dimensions/${validNamespace}/${validPathParts.join('/')}`
    return yield* Result.mapError(MinecraftSavePathBrand.result(pathValue), unsupported)
  })

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
  dimension: unknown,
): Result.Result<MinecraftSavePath, TypeError> => {
  if (typeof dimension !== 'string') {
    return Result.fail(new TypeError(`unsupported Minecraft dimension ${String(dimension)}`))
  }
  switch (dimension) {
    case 'overworld':
    case 'minecraft:overworld':
      return Result.succeed(MinecraftSavePathBrand('dimensions/minecraft/overworld'))
    case 'the_nether':
    case 'minecraft:the_nether':
      return Result.succeed(MinecraftSavePathBrand('dimensions/minecraft/the_nether'))
    case 'the_end':
    case 'minecraft:the_end':
      return Result.succeed(MinecraftSavePathBrand('dimensions/minecraft/the_end'))
    default:
      return dimensionDirectoryForCustomIdentifier(dimension)
  }
}


export const parseMinecraftDimension = (value: unknown): Result.Result<MinecraftDimension, TypeError> => {
  if (typeof value !== 'string') {
    return Result.fail(new TypeError(`unsupported Minecraft dimension ${String(value)}`))
  }
  switch (value) {
    case 'overworld':
    case 'the_nether':
    case 'the_end':
    case 'minecraft:overworld':
    case 'minecraft:the_nether':
    case 'minecraft:the_end':
      return Result.succeed(value)
    default:
      return Result.mapError(
        CustomMinecraftDimensionBrand.result(value),
        () => new TypeError(`unsupported Minecraft dimension ${value}`),
      )
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
): Result.Result<{
  readonly x: AnvilChunkLocalCoordinate
  readonly z: AnvilChunkLocalCoordinate
}, TypeError> =>
  Result.map(validatedChunkCoordinate(coord), (validated) => ({
    x: AnvilChunkLocalCoordinateBrand(
      ((validated.cx % ANVIL_REGION_CHUNK_SIDE) + ANVIL_REGION_CHUNK_SIDE) % ANVIL_REGION_CHUNK_SIDE,
    ),
    z: AnvilChunkLocalCoordinateBrand(
      ((validated.cz % ANVIL_REGION_CHUNK_SIDE) + ANVIL_REGION_CHUNK_SIDE) % ANVIL_REGION_CHUNK_SIDE,
    ),
  }))

export const anvilChunkIndex = (coord: ChunkCoord): Result.Result<AnvilChunkIndex, TypeError> =>
  Result.map(anvilChunkLocalCoordinate(coord), (local) =>
    AnvilChunkIndexBrand(local.x + local.z * ANVIL_REGION_CHUNK_SIDE),
  )

export const anvilRegionFileName = (coord: ChunkCoord): Result.Result<MinecraftPathSegment, TypeError> =>
  Result.map(anvilRegionCoordinate(coord), ({ rx, rz }) =>
    MinecraftPathSegmentBrand(`r.${String(rx)}.${String(rz)}.mca`),
  )

const minecraftRegionStorageDirectory = (
  storage: MinecraftRegionStorage,
): Result.Result<MinecraftPathSegment, TypeError> => {
  switch (storage) {
    case 'region':
    case 'entities':
    case 'poi':
      return Result.succeed(MinecraftPathSegmentBrand(storage))
    default:
      return Result.fail(new TypeError(`unsupported Minecraft region storage ${String(storage)}`))
  }
}

export const minecraftRegionFilePath = (
  dimension: MinecraftDimension,
  coord: ChunkCoord,
  storage: MinecraftRegionStorage = 'region',
): Result.Result<MinecraftSavePath, TypeError> =>
  Result.gen(function* () {
    const directory = yield* minecraftDimensionDirectory(dimension)
    const storageDirectory = yield* minecraftRegionStorageDirectory(storage)
    const file = yield* anvilRegionFileName(coord)
    return MinecraftSavePathBrand(`${directory}/${storageDirectory}/${file}`)
  })

export const minecraftExternalChunkFileName = (
  coord: ChunkCoord,
): Result.Result<MinecraftPathSegment, TypeError> =>
  Result.map(validatedChunkCoordinate(coord), (validated) =>
    MinecraftPathSegmentBrand(
      `c.${String(validated.cx)}.${String(validated.cz)}${ANVIL_EXTERNAL_FILE_EXTENSION}`,
    ),
  )

export const minecraftExternalChunkFilePath = (
  dimension: MinecraftDimension,
  coord: ChunkCoord,
  storage: MinecraftRegionStorage = 'region',
): Result.Result<MinecraftSavePath, TypeError> =>
  Result.gen(function* () {
    const directory = yield* minecraftDimensionDirectory(dimension)
    const storageDirectory = yield* minecraftRegionStorageDirectory(storage)
    const file = yield* minecraftExternalChunkFileName(coord)
    return MinecraftSavePathBrand(`${directory}/${storageDirectory}/${file}`)
  })

export const minecraftLevelDataPath = (): MinecraftSavePath => MinecraftSavePathBrand('level.dat')

export const minecraftLevelDataBackupPath = (): MinecraftSavePath => MinecraftSavePathBrand('level.dat_old')

export const minecraftIconPath = (): MinecraftSavePath => MinecraftSavePathBrand('icon.png')

export const minecraftSessionLockPath = (): MinecraftSavePath => MinecraftSavePathBrand('session.lock')

export const minecraftPlayerDataPath = (playerId: MinecraftPathSegment): Result.Result<MinecraftSavePath, TypeError> =>
  Result.map(pathSegment(playerId, 'player id'), (segment) =>
    MinecraftSavePathBrand(`players/data/${segment}.dat`),
  )

export const minecraftStatsPath = (playerId: MinecraftPathSegment): Result.Result<MinecraftSavePath, TypeError> =>
  Result.map(pathSegment(playerId, 'player id'), (segment) =>
    MinecraftSavePathBrand(`players/stats/${segment}.json`),
  )

export const minecraftAdvancementsPath = (playerId: MinecraftPathSegment): Result.Result<MinecraftSavePath, TypeError> =>
  Result.map(pathSegment(playerId, 'player id'), (segment) =>
    MinecraftSavePathBrand(`players/advancements/${segment}.json`),
  )

export const minecraftDataFilePath = (
  namespace: MinecraftPathSegment,
  name: MinecraftRelativePath,
  dimension?: MinecraftDimension,
): Result.Result<MinecraftSavePath, TypeError> =>
  Result.gen(function* () {
    const dataDirectory =
      dimension === undefined
        ? 'data'
        : `${yield* minecraftDimensionDirectory(dimension)}/data`
    const validatedNamespace = yield* pathSegment(namespace, 'data namespace')
    const validatedName = yield* relativePath(name, 'data file name')
    return MinecraftSavePathBrand(`${dataDirectory}/${validatedNamespace}/${validatedName}`)
  })

export const minecraftCommandStoragePath = (
  namespace: MinecraftPathSegment,
  dimension?: MinecraftDimension,
): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(namespace, MinecraftRelativePathBrand('command_storage.dat'), dimension)

export const minecraftRaidsPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('raids.dat'))

export const minecraftScoreboardPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('scoreboard.dat'))

export const minecraftWorldBorderPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('world_border.dat'))

export const minecraftEnderDragonFightPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(
    MinecraftPathSegmentBrand('minecraft'),
    MinecraftRelativePathBrand('ender_dragon_fight.dat'),
    'the_end',
  )

export const minecraftWanderingTraderPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('wandering_trader.dat'))

export const minecraftCustomBossEventsPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('custom_boss_events.dat'))

export const minecraftWeatherPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('weather.dat'))

export const minecraftScheduledEventsPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('scheduled_events.dat'))

export const minecraftGameRulesPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('game_rules.dat'))

export const minecraftWorldGenSettingsPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('world_gen_settings.dat'))

export const minecraftWorldClocksPath = (): Result.Result<MinecraftSavePath, TypeError> =>
  minecraftDataFilePath(MinecraftPathSegmentBrand('minecraft'), MinecraftRelativePathBrand('world_clocks.dat'))

export const minecraftWorldClockPath = (
  namespace: MinecraftPathSegment,
  id: MinecraftRelativePath,
): Result.Result<MinecraftSavePath, TypeError> =>
  Result.gen(function* () {
    const validatedNamespace = yield* pathSegment(namespace, 'world clock namespace')
    const validatedId = yield* relativePath(id, 'world clock id')
    return MinecraftSavePathBrand(`data/${validatedNamespace}/world_clock/${validatedId}.json`)
  })

export const minecraftMapFilePath = (mapId: MinecraftMapId): Result.Result<MinecraftSavePath, TypeError> =>
  Result.map(parseMinecraftMapId(mapId), (validated) =>
    MinecraftSavePathBrand(`data/minecraft/maps/${validated}.dat`),
  )

export const minecraftLastIdPath = (): MinecraftSavePath =>
  MinecraftSavePathBrand('data/minecraft/last_id.dat')

export const minecraftChunkTicketsPath = (): MinecraftSavePath =>
  MinecraftSavePathBrand('data/minecraft/chunk_tickets.dat')

export const minecraftWorldResourcePackPath = (): MinecraftSavePath =>
  MinecraftSavePathBrand('resourcepacks/resources.zip')

export const minecraftStructurePath = (
  namespace: MinecraftPathSegment,
  structure: MinecraftRelativePath,
): Result.Result<MinecraftSavePath, TypeError> =>
  Result.gen(function* () {
    const validatedNamespace = yield* pathSegment(namespace, 'structure namespace')
    const validatedName = yield* relativePath(structure, 'structure name')
    return MinecraftSavePathBrand(`generated/${validatedNamespace}/structure/${validatedName}.nbt`)
  })

export const ANVIL_REGION_BLOCK_SIDE: AnvilRegionBlockSide =
  AnvilRegionBlockSideBrand(CHUNK_SIZE_XZ * ANVIL_REGION_CHUNK_SIDE)
