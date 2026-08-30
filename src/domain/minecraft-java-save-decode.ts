import { chunkCoord, type ChunkAxis } from '@nerima-games/mc-kernel'
import {
  anvilChunkLocalCoordinate,
  anvilRegionCoordinate,
  type MinecraftDimension,
  type MinecraftRegionStorage,
} from './minecraft-paths.js'
import {
  decodeMinecraftRegionFiles,
  type MinecraftExternalChunkFile,
} from './minecraft-region-files.js'
import { decodeCompressedNbt } from './minecraft-nbt-compression.js'
import { decodeMinecraftJson } from './minecraft-java-save-json.js'
import {
  decodeMinecraftSessionLock,
} from './minecraft-save-files.js'
import {
  errorReason,
  MinecraftJavaSaveError,
  minecraftJavaSaveError,
} from './minecraft-java-save-errors.js'
import { parseMinecraftJavaSavePath, type MinecraftJavaSavePath } from './minecraft-java-save-paths.js'
import type {
  MinecraftJavaDataFile,
  MinecraftJavaPlayerDataFile,
  MinecraftJavaPlayerJsonFile,
  MinecraftJavaRegionFile,
  MinecraftJavaSave,
  MinecraftJavaSaveFile,
  MinecraftJavaStructureFile,
  MinecraftJavaWorldClockFile,
} from './minecraft-java-save-types.js'
import {
  resolveMinecraftJavaSaveOptions,
  validateMinecraftJavaSaveFiles,
} from './minecraft-java-save-validation.js'
type RegionGroup = {
  readonly dimension: MinecraftDimension
  readonly storage: MinecraftRegionStorage
  readonly regionX: ChunkAxis
  readonly regionZ: ChunkAxis
  regionPath?: string
  externalPath?: string
  regionBytes?: Uint8Array
  readonly externalChunks: MinecraftExternalChunkFile[]
}

const asOperation = (
  operation: 'decode',
  error: unknown,
  path?: string,
): MinecraftJavaSaveError => {
  if (error instanceof MinecraftJavaSaveError) {
    return minecraftJavaSaveError(operation, error.reason, path ?? error.path)
  }
  return minecraftJavaSaveError(operation, errorReason(error), path)
}

const filePath = (file: MinecraftJavaSaveFile): string => file.path

const decodeNbtFile = async (
  file: MinecraftJavaSaveFile,
  options: ReturnType<typeof resolveMinecraftJavaSaveOptions>,
): Promise<Awaited<ReturnType<typeof decodeCompressedNbt>>> => {
  try {
    return await decodeCompressedNbt(file.bytes, 'gzip', options.compressedNbt)
  } catch (error) {
    throw asOperation('decode', error, file.path)
  }
}

const decodeJsonFile = (file: MinecraftJavaSaveFile): ReturnType<typeof decodeMinecraftJson> => {
  try {
    return decodeMinecraftJson(file.bytes)
  } catch (error) {
    throw asOperation('decode', error, file.path)
  }
}

const decodeWorldClockFile = (
  file: MinecraftJavaSaveFile,
  namespace: string,
  id: string,
): MinecraftJavaWorldClockFile => {
  const value = decodeJsonFile(file)
  return { namespace, id, value }
}

const addRegion = (
  groups: Map<string, RegionGroup>,
  dimension: MinecraftDimension,
  storage: MinecraftRegionStorage,
  regionX: ChunkAxis,
  regionZ: ChunkAxis,
): RegionGroup => {
  const key = `${dimension}\u0000${storage}\u0000${String(regionX)}\u0000${String(regionZ)}`
  const existing = groups.get(key)
  if (existing !== undefined) return existing
  const group: RegionGroup = {
    dimension,
    storage,
    regionX,
    regionZ,
    externalChunks: [],
  }
  groups.set(key, group)
  return group
}

const descriptorFor = (file: MinecraftJavaSaveFile): MinecraftJavaSavePath => {
  try {
    return parseMinecraftJavaSavePath(file.path)
  } catch (error) {
    throw asOperation('decode', error, file.path)
  }
}

const sortBy = <T>(values: T[], key: (value: T) => string): T[] =>
  values.sort((left, right) => key(left).localeCompare(key(right), 'en'))

const regionSortKey = (region: MinecraftJavaRegionFile): string =>
  `${region.dimension}\u0000${region.storage}\u0000${String(region.regionX)}\u0000${String(region.regionZ)}`

const dataSortKey = (file: MinecraftJavaDataFile): string =>
  `${file.dimension ?? ''}\u0000${file.namespace}\u0000${file.name}`

const worldClockSortKey = (file: MinecraftJavaWorldClockFile): string => `${file.namespace}\u0000${file.id}`

const playerSortKey = (file: MinecraftJavaPlayerDataFile | MinecraftJavaPlayerJsonFile): string => file.playerId

const decodeMinecraftJavaSaveInternal = async (
  files: ReadonlyArray<MinecraftJavaSaveFile>,
  options: ReturnType<typeof resolveMinecraftJavaSaveOptions>,
): Promise<MinecraftJavaSave> => {
  const normalized = validateMinecraftJavaSaveFiles(files, options)
  const regions = new Map<string, RegionGroup>()
  const playerDataEntries: Array<{ readonly file: MinecraftJavaSaveFile; readonly playerId: string }> = []
  const playerStatsEntries: Array<{ readonly file: MinecraftJavaSaveFile; readonly playerId: string }> = []
  const playerAdvancementEntries: Array<{ readonly file: MinecraftJavaSaveFile; readonly playerId: string }> = []
  const dataEntries: Array<{
    readonly file: MinecraftJavaSaveFile
    readonly namespace: string
    readonly name: string
    readonly dimension?: MinecraftDimension
  }> = []
  const worldClockEntries: Array<{
    readonly file: MinecraftJavaSaveFile
    readonly namespace: string
    readonly id: string
  }> = []
  const structureEntries: Array<{
    readonly file: MinecraftJavaSaveFile
    readonly namespace: string
    readonly name: string
  }> = []
  const extraFiles: MinecraftJavaSaveFile[] = []
  let levelFile: MinecraftJavaSaveFile | undefined
  let levelBackupFile: MinecraftJavaSaveFile | undefined
  let sessionLockFile: MinecraftJavaSaveFile | undefined
  let iconFile: MinecraftJavaSaveFile | undefined
  let resourcePackFile: MinecraftJavaSaveFile | undefined

  for (const file of normalized) {
    const descriptor = descriptorFor(file)
    // oxlint-disable-next-line default-case -- descriptor.kind is a 13-variant closed union already covered exhaustively below; a default arm would be unreachable.
    switch (descriptor.kind) {
      case 'level':
        levelFile = file
        break
      case 'levelBackup':
        levelBackupFile = file
        break
      case 'sessionLock':
        sessionLockFile = file
        break
      case 'icon':
        iconFile = file
        break
      case 'resourcePack':
        resourcePackFile = file
        break
      case 'playerData':
        playerDataEntries.push({ file, playerId: descriptor.playerId })
        break
      case 'playerJson':
        if (descriptor.category === 'stats') {
          playerStatsEntries.push({ file, playerId: descriptor.playerId })
        } else {
          playerAdvancementEntries.push({ file, playerId: descriptor.playerId })
        }
        break
      case 'region': {
        // Two distinct 'region'-kind files can never reach this same group: validateMinecraftJavaSaveFiles
        // already rejects duplicate file paths before this loop runs, and the region path grammar (in
        // minecraft-java-save-paths.ts) has exactly one canonical string per (dimension, storage, regionX,
        // regionZ) tuple, so group.regionBytes can never already be set here.
        const group = addRegion(
          regions,
          descriptor.dimension,
          descriptor.storage,
          descriptor.regionX,
          descriptor.regionZ,
        )
        group.regionPath = file.path
        group.regionBytes = file.bytes
        break
      }
      case 'externalChunk': {
        const coordinate = chunkCoord(descriptor.chunkX, descriptor.chunkZ)
        const region = anvilRegionCoordinate(coordinate)
        const local = anvilChunkLocalCoordinate(coordinate)
        const group = addRegion(regions, descriptor.dimension, descriptor.storage, region.rx, region.rz)
        if (group.externalPath === undefined) group.externalPath = file.path
        group.externalChunks.push({ localX: local.x, localZ: local.z, bytes: file.bytes })
        break
      }
      case 'data':
        dataEntries.push({
          file,
          namespace: descriptor.namespace,
          name: descriptor.name,
          ...(descriptor.dimension === undefined ? {} : { dimension: descriptor.dimension }),
        })
        break
      case 'worldClock':
        worldClockEntries.push({ file, namespace: descriptor.namespace, id: descriptor.id })
        break
      case 'structure':
        structureEntries.push({ file, namespace: descriptor.namespace, name: descriptor.name })
        break
      case 'extra':
        extraFiles.push({ path: file.path, bytes: file.bytes.slice() })
        break
    }
  }

  const requiredLevelFile = levelFile
  if (requiredLevelFile === undefined) {
    throw minecraftJavaSaveError('decode', 'level.dat is required', 'level.dat')
  }

  const levelPromise = decodeNbtFile(requiredLevelFile, options)
  const optionalLevelBackupFile = levelBackupFile
  const levelBackupPromise =
    optionalLevelBackupFile === undefined ? undefined : decodeNbtFile(optionalLevelBackupFile, options)
  const playerDataPromise = Promise.all(
    playerDataEntries.map(async ({ file, playerId }): Promise<MinecraftJavaPlayerDataFile> => ({
      playerId,
      document: await decodeNbtFile(file, options),
    })),
  )
  const playerStatsPromise = Promise.all(
    playerStatsEntries.map(
      async ({ file, playerId }): Promise<MinecraftJavaPlayerJsonFile> => ({
        playerId,
        value: decodeJsonFile(file),
      }),
    ),
  )
  const playerAdvancementPromise = Promise.all(
    playerAdvancementEntries.map(
      async ({ file, playerId }): Promise<MinecraftJavaPlayerJsonFile> => ({
        playerId,
        value: decodeJsonFile(file),
      }),
    ),
  )
  const dataPromise = Promise.all(
    dataEntries.map(async ({ file, namespace, name, dimension }): Promise<MinecraftJavaDataFile> => ({
      namespace,
      name,
      ...(dimension === undefined ? {} : { dimension }),
      document: await decodeNbtFile(file, options),
    })),
  )
  const worldClockPromise = Promise.all(
    worldClockEntries.map(
      async ({ file, namespace, id }): Promise<MinecraftJavaWorldClockFile> =>
        decodeWorldClockFile(file, namespace, id),
    ),
  )
  const structurePromise = Promise.all(
    structureEntries.map(async ({ file, namespace, name }): Promise<MinecraftJavaStructureFile> => ({
      namespace,
      name,
      document: await decodeNbtFile(file, options),
    })),
  )
  const regionPromise = Promise.all(
    [...regions.values()].map(async (group): Promise<MinecraftJavaRegionFile> => {
      const regionBytes = group.regionBytes
      const regionPath = group.regionPath
      if (regionBytes === undefined || regionPath === undefined) {
        throw minecraftJavaSaveError('decode', 'external chunk has no matching region file', group.externalPath)
      }
      try {
        return {
          dimension: group.dimension,
          storage: group.storage,
          regionX: group.regionX,
          regionZ: group.regionZ,
          region: decodeMinecraftRegionFiles(regionBytes, group.externalChunks, options.region),
        }
      } catch (error) {
        throw asOperation('decode', error, regionPath)
      }
    }),
  )

  const [
    level,
    levelBackup,
    playerData,
    playerStats,
    playerAdvancements,
    dataFiles,
    worldClocks,
    structures,
    decodedRegions,
  ] = await Promise.all([
    levelPromise,
    levelBackupPromise,
    playerDataPromise,
    playerStatsPromise,
    playerAdvancementPromise,
    dataPromise,
    worldClockPromise,
    structurePromise,
    regionPromise,
  ])

  const save: MinecraftJavaSave = {
    level,
    ...(levelBackup === undefined ? {} : { levelBackup }),
    ...(sessionLockFile === undefined
      ? {}
      : {
          sessionLock: (() => {
            try {
              return decodeMinecraftSessionLock(sessionLockFile.bytes)
            } catch (error) {
              throw asOperation('decode', error, sessionLockFile.path)
            }
          })(),
        }),
    ...(iconFile === undefined ? {} : { icon: iconFile.bytes.slice() }),
    playerData: sortBy(playerData, playerSortKey),
    playerStats: sortBy(playerStats, playerSortKey),
    playerAdvancements: sortBy(playerAdvancements, playerSortKey),
    regions: sortBy(decodedRegions, regionSortKey),
    dataFiles: sortBy(dataFiles, dataSortKey),
    worldClocks: sortBy(worldClocks, worldClockSortKey),
    structures: sortBy(structures, (file) => `${file.namespace}\u0000${file.name}`),
    ...(resourcePackFile === undefined ? {} : { resourcePack: resourcePackFile.bytes.slice() }),
    extraFiles: sortBy(extraFiles, filePath),
  }
  return save
}

export const decodeMinecraftJavaSave = async (
  files: ReadonlyArray<MinecraftJavaSaveFile>,
  options?: Parameters<typeof resolveMinecraftJavaSaveOptions>[0],
): Promise<MinecraftJavaSave> => {
  try {
    return await decodeMinecraftJavaSaveInternal(files, resolveMinecraftJavaSaveOptions(options))
  } catch (error) {
    throw asOperation('decode', error)
  }
}
