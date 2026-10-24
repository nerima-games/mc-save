import { ChunkAxis, chunkCoord } from '@nerima-games/mc-kernel/domain/coordinates'
import { Effect, Result } from 'effect'
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

const asOperation = (error: unknown, operation: 'encode', path?: string): MinecraftJavaSaveError =>
  minecraftJavaSaveError(operation, errorReason(error), path)


const operationError = (operation: 'encode', path?: string) =>
  (error: unknown): MinecraftJavaSaveError => asOperation(error, operation, path)

const encodeNbtFile = (
  path: string,
  document: Parameters<typeof encodeCompressedNbt>[0],
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<MinecraftJavaSaveFile, MinecraftJavaSaveError> =>
  encodeCompressedNbt(document, 'gzip', options.compressedNbt).pipe(
    Effect.map((bytes) => ({ path, bytes })),
    Effect.mapError(operationError('encode', path)),
  )

const encodeNbtFileAtPath = (
  path: Result.Result<string, unknown>,
  document: Parameters<typeof encodeCompressedNbt>[0],
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<MinecraftJavaSaveFile, MinecraftJavaSaveError> =>
  Effect.gen(function* () {
    const validatedPath = yield* Effect.fromResult(Result.mapError(path, operationError('encode')))
    return yield* encodeNbtFile(validatedPath, document, options)
  })

const encodeJsonFile = (
  path: Result.Result<string, unknown>,
  value: Parameters<typeof encodeMinecraftJson>[0],
): Effect.Effect<MinecraftJavaSaveFile, MinecraftJavaSaveError> =>
  Effect.gen(function* () {
    const validatedPath = yield* Effect.fromResult(Result.mapError(path, operationError('encode')))
    const bytes = yield* Effect.fromResult(
      Result.mapError(encodeMinecraftJson(value), operationError('encode', validatedPath)),
    )
    return { path: validatedPath, bytes }
  })

// regionOrigin's product is not re-guarded for safe-integer overflow: validateMinecraftJavaSave (the first
// call in encodeMinecraftJavaSaveInternal, ahead of every promise below) already rejects any regionX/regionZ
// via isSafeRegionCoordinate using this exact same `value * ANVIL_REGION_CHUNK_SIDE` safety condition, so by
// the time this runs the product is already guaranteed safe.
const regionOrigin = (axis: ReturnType<typeof ChunkAxis>): ReturnType<typeof ChunkAxis> =>
  ChunkAxis(Number(axis) * ANVIL_REGION_CHUNK_SIDE)

const externalChunkPath = (
  dimension: MinecraftDimension,
  storage: MinecraftRegionStorage,
  originX: ReturnType<typeof ChunkAxis>,
  originZ: ReturnType<typeof ChunkAxis>,
  localX: number,
  localZ: number,
): Result.Result<string, TypeError> =>
  minecraftExternalChunkFilePath(
    dimension,
    chunkCoord(
      ChunkAxis(Number(originX) + localX),
      ChunkAxis(Number(originZ) + localZ),
    ),
    storage,
  )

const encodeRegion = (
  region: MinecraftJavaRegionFile,
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveError> =>
  Effect.gen(function* () {
    const originX = regionOrigin(region.regionX)
    const originZ = regionOrigin(region.regionZ)
    const coordinate = chunkCoord(originX, originZ)
    const regionPath = yield* Effect.fromResult(
      Result.mapError(
        minecraftRegionFilePath(region.dimension, coordinate, region.storage),
        operationError('encode'),
      ),
    )
    const encoded = yield* Effect.fromResult(
      Result.mapError(
        encodeMinecraftRegionFiles(region.region, options.region),
        operationError('encode', regionPath),
      ),
    )
    const externalFiles = yield* Effect.all(
      encoded.externalChunks.map((external) =>
        Effect.gen(function* () {
          const path = yield* Effect.fromResult(
            Result.mapError(
              externalChunkPath(
                region.dimension,
                region.storage,
                originX,
                originZ,
                external.localX,
                external.localZ,
              ),
              operationError('encode'),
            ),
          )
          return { path, bytes: external.bytes }
        }),
      ),
      { concurrency: 'unbounded' },
    )
    return [{ path: regionPath, bytes: encoded.region }, ...externalFiles]
  })

const encodeMinecraftJavaSaveInternal = (
  input: MinecraftJavaSave,
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveError> =>
  Effect.gen(function* () {
    const save = yield* Effect.fromResult(validateMinecraftJavaSave(input, options))
    const level = yield* encodeNbtFile(minecraftLevelDataPath(), save.level, options)
    const levelBackup =
      save.levelBackup === undefined
        ? undefined
        : yield* encodeNbtFile(minecraftLevelDataBackupPath(), save.levelBackup, options)
    const grouped = yield* Effect.all(
      {
        playerData: Effect.all(
          save.playerData.map((file: MinecraftJavaPlayerDataFile) =>
            encodeNbtFileAtPath(minecraftPlayerDataPath(file.playerId), file.document, options),
          ),
          { concurrency: 'unbounded' },
        ),
        playerStats: Effect.all(
          save.playerStats.map((file: MinecraftJavaPlayerJsonFile) =>
            encodeJsonFile(minecraftStatsPath(file.playerId), file.value),
          ),
          { concurrency: 'unbounded' },
        ),
        playerAdvancements: Effect.all(
          save.playerAdvancements.map((file: MinecraftJavaPlayerJsonFile) =>
            encodeJsonFile(minecraftAdvancementsPath(file.playerId), file.value),
          ),
          { concurrency: 'unbounded' },
        ),
        dataFiles: Effect.all(
          save.dataFiles.map((file: MinecraftJavaDataFile) =>
            encodeNbtFileAtPath(
              minecraftDataFilePath(file.namespace, file.name, file.dimension),
              file.document,
              options,
            ),
          ),
          { concurrency: 'unbounded' },
        ),
        worldClocks: Effect.all(
          save.worldClocks.map((file) =>
            encodeJsonFile(minecraftWorldClockPath(file.namespace, file.id), file.value),
          ),
          { concurrency: 'unbounded' },
        ),
        structures: Effect.all(
          save.structures.map((file: MinecraftJavaStructureFile) =>
            encodeNbtFileAtPath(minecraftStructurePath(file.namespace, file.name), file.document, options),
          ),
          { concurrency: 'unbounded' },
        ),
        regions: Effect.all(save.regions.map((region) => encodeRegion(region, options)), {
          concurrency: 'unbounded',
        }),
      },
      { concurrency: 'unbounded' },
    )
    const files: MinecraftJavaSaveFile[] = [
      level,
      ...grouped.playerData,
      ...grouped.playerStats,
      ...grouped.playerAdvancements,
      ...grouped.dataFiles,
      ...grouped.worldClocks,
      ...grouped.structures,
      ...grouped.regions.flat(),
    ]
    if (levelBackup !== undefined) files.push(levelBackup)
    if (save.sessionLock !== undefined) {
      const bytes = yield* Effect.fromResult(
        Result.mapError(
          encodeMinecraftSessionLock(save.sessionLock),
          operationError('encode', minecraftSessionLockPath()),
        ),
      )
      files.push({ path: minecraftSessionLockPath(), bytes })
    }
    if (save.icon !== undefined) files.push({ path: minecraftIconPath(), bytes: save.icon.slice() })
    if (save.resourcePack !== undefined) {
      files.push({ path: minecraftWorldResourcePackPath(), bytes: save.resourcePack.slice() })
    }
    for (const file of save.extraFiles) files.push({ path: file.path, bytes: file.bytes.slice() })
    return yield* Effect.fromResult(validateMinecraftJavaSaveFiles(files, options))
  })

export const encodeMinecraftJavaSave = (
  save: MinecraftJavaSave,
  options?: MinecraftJavaSaveOptions,
): Effect.Effect<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveError> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.fromResult(resolveMinecraftJavaSaveOptions(options))
    return yield* encodeMinecraftJavaSaveInternal(save, resolved)
  })
