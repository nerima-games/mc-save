import { ChunkAxis, chunkCoord } from '@nerima-games/mc-kernel/domain/coordinates'
import { Effect, Result } from 'effect'
import { ANVIL_REGION_CHUNK_SIDE } from './anvil-region.js'
import type { AnvilLocalCoordinate } from './anvil-region.js'
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
  type MinecraftSavePath,
  type MinecraftRegionStorage,
} from './minecraft-paths.js'
import { parseMinecraftJavaSaveFilePath } from './minecraft-java-save-paths.js'
import { encodeMinecraftRegionFiles } from './minecraft-region-files.js'
import { encodeMinecraftSessionLock } from './minecraft-save-files.js'
import type {
  MinecraftJavaDataFile,
  MinecraftJavaPlayerDataFile,
  MinecraftJavaPlayerJsonFile,
  MinecraftJavaRegionFile,
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

type MinecraftJavaSaveFailure = MinecraftJavaSaveError | TypeError

const asOperation = (
  error: unknown,
  operation: 'encode',
  path?: string,
): Result.Result<MinecraftJavaSaveError, TypeError> =>
  Result.gen(function* () {
    const reason = yield* errorReason(error)
    return yield* minecraftJavaSaveError(operation, reason, path)
  })

const failureFrom = <A, E>(result: Result.Result<A, E>): Result.Result<never, A | E> => {
  if (Result.isFailure(result)) return Result.fail(result.failure)
  return Result.fail(result.success)
}

const operationError = (operation: 'encode', path?: string) =>
  (error: unknown): Result.Result<never, MinecraftJavaSaveFailure> =>
    failureFrom(asOperation(error, operation, path))

const mapResultError = <A, E>(
  result: Result.Result<A, E>,
  mapError: (error: E) => Result.Result<never, MinecraftJavaSaveFailure>,
): Result.Result<A, MinecraftJavaSaveFailure> => {
  if (Result.isSuccess(result)) return Result.succeed(result.success)
  return mapError(result.failure)
}

const mapEffectError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  mapError: (error: E) => Result.Result<never, MinecraftJavaSaveFailure>,
): Effect.Effect<A, MinecraftJavaSaveFailure, R> =>
  Effect.matchEffect(effect, {
    onFailure: (error) => Effect.fromResult(mapError(error)),
    onSuccess: Effect.succeed,
  })

const encodeNbtFile = (
  path: MinecraftSavePath,
  document: Parameters<typeof encodeCompressedNbt>[0],
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<MinecraftJavaSaveFile, MinecraftJavaSaveFailure> =>
  Effect.gen(function* () {
    const filePath = yield* Effect.fromResult(
      mapResultError(parseMinecraftJavaSaveFilePath(path), operationError('encode')),
    )
    const bytes = yield* mapEffectError(
      encodeCompressedNbt(document, 'gzip', options.compressedNbt),
      operationError('encode', path),
    )
    return { path: filePath, bytes }
  })

const encodeNbtFileAtPath = (
  path: Result.Result<MinecraftSavePath, unknown>,
  document: Parameters<typeof encodeCompressedNbt>[0],
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<MinecraftJavaSaveFile, MinecraftJavaSaveFailure> =>
  Effect.gen(function* () {
    const validatedPath = yield* Effect.fromResult(mapResultError(path, operationError('encode')))
    return yield* encodeNbtFile(validatedPath, document, options)
  })

const encodeJsonFile = (
  path: Result.Result<MinecraftSavePath, unknown>,
  value: Parameters<typeof encodeMinecraftJson>[0],
): Effect.Effect<MinecraftJavaSaveFile, MinecraftJavaSaveFailure> =>
  Effect.gen(function* () {
    const validatedPath = yield* Effect.fromResult(mapResultError(path, operationError('encode')))
    const filePath = yield* Effect.fromResult(
      mapResultError(parseMinecraftJavaSaveFilePath(validatedPath), operationError('encode', validatedPath)),
    )
    const bytes = yield* Effect.fromResult(
      mapResultError(encodeMinecraftJson(value), operationError('encode', validatedPath)),
    )
    return { path: filePath, bytes }
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
  localX: AnvilLocalCoordinate,
  localZ: AnvilLocalCoordinate,
): Result.Result<MinecraftSavePath, TypeError> =>
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
): Effect.Effect<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveFailure> =>
  Effect.gen(function* () {
    const originX = regionOrigin(region.regionX)
    const originZ = regionOrigin(region.regionZ)
    const coordinate = chunkCoord(originX, originZ)
    const regionPath = yield* Effect.fromResult(
      mapResultError(
        minecraftRegionFilePath(region.dimension, coordinate, region.storage),
        operationError('encode'),
      ),
    )
    const fileRegionPath = yield* Effect.fromResult(
      mapResultError(parseMinecraftJavaSaveFilePath(regionPath), operationError('encode', regionPath)),
    )
    const encoded = yield* Effect.fromResult(
      mapResultError(
        encodeMinecraftRegionFiles(region.region, options.region),
        operationError('encode', regionPath),
      ),
    )
    const externalFiles = yield* Effect.all(
      encoded.externalChunks.map((external) =>
        Effect.gen(function* () {
          const path = yield* Effect.fromResult(
              mapResultError(
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
          const filePath = yield* Effect.fromResult(
            mapResultError(parseMinecraftJavaSaveFilePath(path), operationError('encode', path)),
          )
          return { path: filePath, bytes: external.bytes }
        }),
      ),
      { concurrency: 'unbounded' },
    )
    return [{ path: fileRegionPath, bytes: encoded.region }, ...externalFiles]
  })

const encodeMinecraftJavaSaveInternal = (
  input: unknown,
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveFailure> =>
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
        mapResultError(
          encodeMinecraftSessionLock(save.sessionLock),
          operationError('encode', minecraftSessionLockPath()),
        ),
      )
      const path = yield* Effect.fromResult(
        mapResultError(
          parseMinecraftJavaSaveFilePath(minecraftSessionLockPath()),
          operationError('encode', minecraftSessionLockPath()),
        ),
      )
      files.push({ path, bytes })
    }
    if (save.icon !== undefined) {
      const path = yield* Effect.fromResult(
        mapResultError(parseMinecraftJavaSaveFilePath(minecraftIconPath()), operationError('encode', minecraftIconPath())),
      )
      files.push({ path, bytes: save.icon.slice() })
    }
    if (save.resourcePack !== undefined) {
      const path = yield* Effect.fromResult(
        mapResultError(
          parseMinecraftJavaSaveFilePath(minecraftWorldResourcePackPath()),
          operationError('encode', minecraftWorldResourcePackPath()),
        ),
      )
      files.push({ path, bytes: save.resourcePack.slice() })
    }
    for (const file of save.extraFiles) files.push({ path: file.path, bytes: file.bytes.slice() })
    return yield* Effect.fromResult(validateMinecraftJavaSaveFiles(files, options))
  })

export const encodeMinecraftJavaSave = (
  save: unknown,
  options?: MinecraftJavaSaveOptions,
): Effect.Effect<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveFailure> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.fromResult(resolveMinecraftJavaSaveOptions(options))
    return yield* Effect.matchEffect(encodeMinecraftJavaSaveInternal(save, resolved), {
      onFailure: (error) => {
        if (error instanceof MinecraftJavaSaveError && error.operation === 'validate') {
          return Effect.fromResult(failureFrom(minecraftJavaSaveError('encode', error.reason, error.path)))
        }
        return Effect.fail(error)
      },
      onSuccess: Effect.succeed,
    })
  })
