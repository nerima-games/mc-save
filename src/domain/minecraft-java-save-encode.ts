import { ChunkAxis, chunkCoord } from '@nerima-games/mc-kernel'
import { ANVIL_REGION_CHUNK_SIDE } from './anvil-region.js'
import { encodeCompressedNbt } from './minecraft-nbt-compression.js'
import { encodeMinecraftJson } from './minecraft-java-save-json.js'
import {
  errorReason,
  MinecraftJavaSaveError,
  minecraftJavaSaveError,
} from './minecraft-java-save-errors.js'
import {
  minecraftDataFilePath,
  minecraftExternalChunkFilePath,
  minecraftLevelDataBackupPath,
  minecraftLevelDataPath,
  minecraftIconPath,
  minecraftPlayerDataPath,
  minecraftRegionFilePath,
  minecraftSessionLockPath,
  minecraftStatsPath,
  minecraftAdvancementsPath,
  minecraftStructurePath,
  minecraftWorldResourcePackPath,
  minecraftWorldClockPath,
  type MinecraftDimension,
  type MinecraftRegionStorage,
} from './minecraft-paths.js'
import { encodeMinecraftRegionFiles } from './minecraft-region-files.js'
import { encodeMinecraftSessionLock } from './minecraft-save-files.js'
import type {
  MinecraftJavaDataFile,
  MinecraftJavaPlayerDataFile,
  MinecraftJavaPlayerJsonFile,
  MinecraftJavaRegionFile,
  MinecraftJavaSave,
  MinecraftJavaSaveFile,
  MinecraftJavaSaveOptions,
  MinecraftJavaStructureFile,
} from './minecraft-java-save-types.js'
import {
  resolveMinecraftJavaSaveOptions,
  validateMinecraftJavaSave,
  validateMinecraftJavaSaveFiles,
  type ResolvedMinecraftJavaSaveOptions,
} from './minecraft-java-save-validation.js'

const asOperation = (error: unknown, path?: string): MinecraftJavaSaveError => {
  if (error instanceof MinecraftJavaSaveError) {
    return minecraftJavaSaveError('encode', error.reason, path ?? error.path)
  }
  return minecraftJavaSaveError('encode', errorReason(error), path)
}

const encodeNbtFile = async (
  path: string,
  document: Parameters<typeof encodeCompressedNbt>[0],
  options: ResolvedMinecraftJavaSaveOptions,
): Promise<MinecraftJavaSaveFile> => {
  try {
    return {
      path,
      bytes: await encodeCompressedNbt(document, 'gzip', options.compressedNbt),
    }
  } catch (error) {
    throw asOperation(error, path)
  }
}

const encodeJsonFile = (path: string, value: Parameters<typeof encodeMinecraftJson>[0]): MinecraftJavaSaveFile => {
  try {
    return { path, bytes: encodeMinecraftJson(value) }
  } catch (error) {
    throw asOperation(error, path)
  }
}

const regionOrigin = (axis: ReturnType<typeof ChunkAxis>): ReturnType<typeof ChunkAxis> => {
  const value = Number(axis) * ANVIL_REGION_CHUNK_SIDE
  if (!Number.isSafeInteger(value)) {
    throw minecraftJavaSaveError('encode', 'region coordinate is outside the safe chunk coordinate range')
  }
  return ChunkAxis(value)
}

const externalChunkPath = (
  dimension: MinecraftDimension,
  storage: MinecraftRegionStorage,
  originX: ReturnType<typeof ChunkAxis>,
  originZ: ReturnType<typeof ChunkAxis>,
  localX: number,
  localZ: number,
): string => {
  const chunkX = Number(originX) + localX
  const chunkZ = Number(originZ) + localZ
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw minecraftJavaSaveError('encode', 'external chunk coordinate is outside the safe chunk coordinate range')
  }
  return minecraftExternalChunkFilePath(dimension, chunkCoord(chunkX, chunkZ), storage)
}

const encodeRegion = (
  region: MinecraftJavaRegionFile,
  options: ResolvedMinecraftJavaSaveOptions,
): ReadonlyArray<MinecraftJavaSaveFile> => {
  try {
    const originX = regionOrigin(region.regionX)
    const originZ = regionOrigin(region.regionZ)
    const encoded = encodeMinecraftRegionFiles(region.region, options.region)
    const files: MinecraftJavaSaveFile[] = [
      {
        path: minecraftRegionFilePath(region.dimension, chunkCoord(originX, originZ), region.storage),
        bytes: encoded.region,
      },
    ]
    for (const external of encoded.externalChunks) {
      files.push({
        path: externalChunkPath(
          region.dimension,
          region.storage,
          originX,
          originZ,
          external.localX,
          external.localZ,
        ),
        bytes: external.bytes,
      })
    }
    return files
  } catch (error) {
    throw asOperation(error)
  }
}

const encodeMinecraftJavaSaveInternal = async (
  save: MinecraftJavaSave,
  options: ResolvedMinecraftJavaSaveOptions,
): Promise<ReadonlyArray<MinecraftJavaSaveFile>> => {
  validateMinecraftJavaSave(save)

  const levelPromise = encodeNbtFile(minecraftLevelDataPath(), save.level, options)
  const levelBackupPromise =
    save.levelBackup === undefined
      ? Promise.resolve(undefined)
      : encodeNbtFile(minecraftLevelDataBackupPath(), save.levelBackup, options)
  const playerDataPromise = Promise.all(
    save.playerData.map((file: MinecraftJavaPlayerDataFile) =>
      encodeNbtFile(minecraftPlayerDataPath(file.playerId), file.document, options),
    ),
  )
  const playerStatsPromise = Promise.all(
    save.playerStats.map((file: MinecraftJavaPlayerJsonFile) =>
      Promise.resolve(encodeJsonFile(minecraftStatsPath(file.playerId), file.value)),
    ),
  )
  const playerAdvancementsPromise = Promise.all(
    save.playerAdvancements.map((file: MinecraftJavaPlayerJsonFile) =>
      Promise.resolve(encodeJsonFile(minecraftAdvancementsPath(file.playerId), file.value)),
    ),
  )
  const dataPromise = Promise.all(
    save.dataFiles.map((file: MinecraftJavaDataFile) =>
      encodeNbtFile(minecraftDataFilePath(file.namespace, file.name, file.dimension), file.document, options),
    ),
  )
  const worldClockPromise = Promise.all(
    save.worldClocks.map((file) =>
      Promise.resolve(encodeJsonFile(minecraftWorldClockPath(file.namespace, file.id), file.value)),
    ),
  )
  const structurePromise = Promise.all(
    save.structures.map((file: MinecraftJavaStructureFile) =>
      encodeNbtFile(minecraftStructurePath(file.namespace, file.name), file.document, options),
    ),
  )
  const regionPromise = Promise.resolve(save.regions.flatMap((region) => encodeRegion(region, options)))

  const [level, levelBackup, playerData, playerStats, playerAdvancements, dataFiles, worldClocks, structures, regions] =
    await Promise.all([
      levelPromise,
      levelBackupPromise,
      playerDataPromise,
      playerStatsPromise,
      playerAdvancementsPromise,
      dataPromise,
      worldClockPromise,
      structurePromise,
      regionPromise,
    ])

  const files: MinecraftJavaSaveFile[] = [
    level,
    ...playerData,
    ...playerStats,
    ...playerAdvancements,
    ...dataFiles,
    ...worldClocks,
    ...structures,
    ...regions,
  ]
  if (levelBackup !== undefined) files.push(levelBackup)
  if (save.sessionLock !== undefined) {
    try {
      files.push({ path: minecraftSessionLockPath(), bytes: encodeMinecraftSessionLock(save.sessionLock) })
    } catch (error) {
      throw asOperation(error, minecraftSessionLockPath())
    }
  }
  if (save.icon !== undefined) files.push({ path: minecraftIconPath(), bytes: save.icon.slice() })
  if (save.resourcePack !== undefined) {
    files.push({ path: minecraftWorldResourcePackPath(), bytes: save.resourcePack.slice() })
  }
  for (const file of save.extraFiles) files.push({ path: file.path, bytes: file.bytes.slice() })
  return validateMinecraftJavaSaveFiles(files, options)
}

export const encodeMinecraftJavaSave = async (
  save: MinecraftJavaSave,
  options?: MinecraftJavaSaveOptions,
): Promise<ReadonlyArray<MinecraftJavaSaveFile>> => {
  try {
    return await encodeMinecraftJavaSaveInternal(save, resolveMinecraftJavaSaveOptions(options))
  } catch (error) {
    throw asOperation(error)
  }
}
