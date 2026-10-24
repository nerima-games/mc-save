import { ChunkAxis, chunkCoord, type ChunkAxis as ChunkAxisType } from '@nerima-games/mc-kernel/domain/coordinates'
import { Effect, Result } from 'effect'
import { ANVIL_REGION_CHUNK_SIDE } from './anvil-region.js'
import {
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
  validateMinecraftJavaSave,
  validateMinecraftJavaSaveFiles,
  type ResolvedMinecraftJavaSaveOptions,
} from './minecraft-java-save-validation.js'
type RegionGroup = {
  readonly dimension: MinecraftDimension
  readonly storage: MinecraftRegionStorage
  readonly regionX: ChunkAxisType
  readonly regionZ: ChunkAxisType
  regionPath?: string
  externalPath?: string
  regionBytes?: Uint8Array
  readonly externalChunks: MinecraftExternalChunkFile[]
}

const asOperation = (error: unknown, path?: string): MinecraftJavaSaveError =>
  minecraftJavaSaveError('decode', errorReason(error), path)


const operationError = (path?: string) =>
  (error: unknown): MinecraftJavaSaveError => asOperation(error, path)

const filePath = (file: MinecraftJavaSaveFile): string => file.path

const decodeNbtFile = (
  file: MinecraftJavaSaveFile,
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<MinecraftJavaSave['level'], MinecraftJavaSaveError> =>
  decodeCompressedNbt(file.bytes, 'gzip', options.compressedNbt).pipe(
    Effect.mapError(operationError(file.path)),
  )

const decodeJsonFile = (file: MinecraftJavaSaveFile): Result.Result<
  MinecraftJavaWorldClockFile['value'],
  MinecraftJavaSaveError
> => Result.mapError(decodeMinecraftJson(file.bytes), operationError(file.path))

const decodeWorldClockFile = (
  file: MinecraftJavaSaveFile,
  namespace: string,
  id: string,
): Result.Result<MinecraftJavaWorldClockFile, MinecraftJavaSaveError> =>
  Result.map(decodeJsonFile(file), (value) => ({ namespace, id, value }))

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

const descriptorFor = (file: MinecraftJavaSaveFile): Result.Result<MinecraftJavaSavePath, MinecraftJavaSaveError> =>
  Result.mapError(parseMinecraftJavaSavePath(file.path), operationError(file.path))

const sortBy = <T>(values: T[], key: (value: T) => string): T[] =>
  values.sort((left, right) => key(left).localeCompare(key(right), 'en'))

const regionSortKey = (region: MinecraftJavaRegionFile): string =>
  `${region.dimension}\u0000${region.storage}\u0000${String(region.regionX)}\u0000${String(region.regionZ)}`

const dataSortKey = (file: MinecraftJavaDataFile): string =>
  `${file.dimension ?? ''}\u0000${file.namespace}\u0000${file.name}`

const worldClockSortKey = (file: MinecraftJavaWorldClockFile): string => `${file.namespace}\u0000${file.id}`

const playerSortKey = (file: MinecraftJavaPlayerDataFile | MinecraftJavaPlayerJsonFile): string => file.playerId

const decodeMinecraftJavaSaveInternal = (
  files: ReadonlyArray<MinecraftJavaSaveFile>,
  options: ResolvedMinecraftJavaSaveOptions,
): Effect.Effect<MinecraftJavaSave, MinecraftJavaSaveError> =>
  Effect.gen(function* () {
    const normalized = yield* Effect.fromResult(validateMinecraftJavaSaveFiles(files, options))
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
      const descriptor = yield* Effect.fromResult(descriptorFor(file))
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
          const chunkX = Number(coordinate.cx)
          const chunkZ = Number(coordinate.cz)
          const regionX = ChunkAxis(Math.floor(chunkX / ANVIL_REGION_CHUNK_SIDE))
          const regionZ = ChunkAxis(Math.floor(chunkZ / ANVIL_REGION_CHUNK_SIDE))
          const localX = ((chunkX % ANVIL_REGION_CHUNK_SIDE) + ANVIL_REGION_CHUNK_SIDE) % ANVIL_REGION_CHUNK_SIDE
          const localZ = ((chunkZ % ANVIL_REGION_CHUNK_SIDE) + ANVIL_REGION_CHUNK_SIDE) % ANVIL_REGION_CHUNK_SIDE
          const group = addRegion(regions, descriptor.dimension, descriptor.storage, regionX, regionZ)
          if (group.externalPath === undefined) group.externalPath = file.path
          group.externalChunks.push({ localX, localZ, bytes: file.bytes })
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

    if (levelFile === undefined) {
      return yield* Effect.fail(minecraftJavaSaveError('decode', 'level.dat is required', 'level.dat'))
    }
    const grouped = yield* Effect.all(
      {
        level: decodeNbtFile(levelFile, options),
        levelBackup:
          levelBackupFile === undefined ? Effect.succeed(undefined) : decodeNbtFile(levelBackupFile, options),
        playerData: Effect.all(
          playerDataEntries.map(({ file, playerId }): Effect.Effect<MinecraftJavaPlayerDataFile, MinecraftJavaSaveError> =>
            Effect.map(decodeNbtFile(file, options), (document) => ({ playerId, document })),
          ),
          { concurrency: 'unbounded' },
        ),
        playerStats: Effect.all(
          playerStatsEntries.map(({ file, playerId }) =>
            Effect.fromResult(
              Result.map(decodeJsonFile(file), (value): MinecraftJavaPlayerJsonFile => ({ playerId, value })),
            ),
          ),
          { concurrency: 'unbounded' },
        ),
        playerAdvancements: Effect.all(
          playerAdvancementEntries.map(({ file, playerId }) =>
            Effect.fromResult(
              Result.map(decodeJsonFile(file), (value): MinecraftJavaPlayerJsonFile => ({ playerId, value })),
            ),
          ),
          { concurrency: 'unbounded' },
        ),
        dataFiles: Effect.all(
          dataEntries.map(
            ({ file, namespace, name, dimension }): Effect.Effect<MinecraftJavaDataFile, MinecraftJavaSaveError> =>
              Effect.map(decodeNbtFile(file, options), (document) => ({
                namespace,
                name,
                ...(dimension === undefined ? {} : { dimension }),
                document,
              })),
          ),
          { concurrency: 'unbounded' },
        ),
        worldClocks: Effect.all(
          worldClockEntries.map(({ file, namespace, id }) =>
            Effect.fromResult(decodeWorldClockFile(file, namespace, id)),
          ),
          { concurrency: 'unbounded' },
        ),
        structures: Effect.all(
          structureEntries.map(
            ({ file, namespace, name }): Effect.Effect<MinecraftJavaStructureFile, MinecraftJavaSaveError> =>
              Effect.map(decodeNbtFile(file, options), (document) => ({ namespace, name, document })),
          ),
          { concurrency: 'unbounded' },
        ),
        regions: Effect.all(
          [...regions.values()].map((group): Effect.Effect<MinecraftJavaRegionFile, MinecraftJavaSaveError> =>
            Effect.gen(function* () {
              const regionBytes = group.regionBytes
              const regionPath = group.regionPath
              if (regionBytes === undefined || regionPath === undefined) {
                return yield* Effect.fail(
                  minecraftJavaSaveError('decode', 'external chunk has no matching region file', group.externalPath),
                )
              }
              const region = yield* Effect.fromResult(
                Result.mapError(
                  decodeMinecraftRegionFiles(regionBytes, group.externalChunks, options.region),
                  operationError(regionPath),
                ),
              )
              return {
                dimension: group.dimension,
                storage: group.storage,
                regionX: group.regionX,
                regionZ: group.regionZ,
                region,
              }
            }),
          ),
          { concurrency: 'unbounded' },
        ),
        sessionLock:
          sessionLockFile === undefined
            ? Effect.succeed(undefined)
            : Effect.fromResult(
                Result.mapError(
                  decodeMinecraftSessionLock(sessionLockFile.bytes),
                  operationError(sessionLockFile.path),
                ),
              ),
      },
      { concurrency: 'unbounded' },
    )

    const save: MinecraftJavaSave = {
      level: grouped.level,
      ...(grouped.levelBackup === undefined ? {} : { levelBackup: grouped.levelBackup }),
      ...(grouped.sessionLock === undefined ? {} : { sessionLock: grouped.sessionLock }),
      ...(iconFile === undefined ? {} : { icon: iconFile.bytes.slice() }),
      playerData: sortBy(grouped.playerData, playerSortKey),
      playerStats: sortBy(grouped.playerStats, playerSortKey),
      playerAdvancements: sortBy(grouped.playerAdvancements, playerSortKey),
      regions: sortBy(grouped.regions, regionSortKey),
      dataFiles: sortBy(grouped.dataFiles, dataSortKey),
      worldClocks: sortBy(grouped.worldClocks, worldClockSortKey),
      structures: sortBy(grouped.structures, (file) => `${file.namespace}\\u0000${file.name}`),
      ...(resourcePackFile === undefined ? {} : { resourcePack: resourcePackFile.bytes.slice() }),
      extraFiles: sortBy(extraFiles, filePath),
    }
    return yield* Effect.fromResult(validateMinecraftJavaSave(save, options))
  })

export const decodeMinecraftJavaSave = (
  files: ReadonlyArray<MinecraftJavaSaveFile>,
  options?: Parameters<typeof resolveMinecraftJavaSaveOptions>[0],
): Effect.Effect<MinecraftJavaSave, MinecraftJavaSaveError> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.fromResult(resolveMinecraftJavaSaveOptions(options))
    return yield* decodeMinecraftJavaSaveInternal(files, resolved)
  })
