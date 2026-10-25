import { ChunkAxis } from '@nerima-games/mc-kernel/domain/coordinates'
import { Brand, Result } from 'effect'
import { SaveMaxBytes } from './brand-types.js'
import type { NbtCodecOptions } from './minecraft-nbt-codec.js'
import {
  ANVIL_REGION_CHUNK_SIDE,
  anvilRegion,
  type AnvilRegion,
} from './anvil-region.js'
import { isMinecraftJsonValue } from './minecraft-java-save-json.js'
import { isMinecraftNbtDocument } from './minecraft-nbt-validation.js'
import { parseMinecraftJavaSaveFilePath } from './minecraft-java-save-paths.js'
import type {
  MinecraftJavaDataFile,
  MinecraftJavaPlayerDataFile,
  MinecraftJavaPlayerJsonFile,
  MinecraftJavaSave,
  MinecraftJavaSaveFile,
  MinecraftJavaSaveFilePath,
  MinecraftJavaStructureFile,
  MinecraftJavaWorldClockFile,
} from './minecraft-java-save-types.js'
import { minecraftJavaSaveError, type MinecraftJavaSaveError } from './minecraft-java-save-errors.js'
import type { MinecraftCompressedNbtOptions } from './minecraft-nbt-compression.js'
import type { MinecraftRegionFilesOptions } from './minecraft-region-files.js'
import {
  parseMinecraftDimension,
  parseMinecraftPathSegment,
  parseMinecraftRelativePath,
} from './minecraft-paths.js'
import type { MinecraftRegionStorage } from './minecraft-paths.js'

export type MinecraftJavaSaveFileCountLimit = number & Brand.Brand<'MinecraftJavaSaveFileCountLimit'>

const toMinecraftJavaSaveFileCountLimit = Brand.make<MinecraftJavaSaveFileCountLimit>(
  (value) => Number.isSafeInteger(value) && value >= 0 || 'file count limit must be a non-negative safe integer',
)

export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILES: MinecraftJavaSaveFileCountLimit =
  toMinecraftJavaSaveFileCountLimit(100_000)
export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILE_BYTES: SaveMaxBytes = SaveMaxBytes(64 * 1024 * 1024)
export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_TOTAL_BYTES: SaveMaxBytes = SaveMaxBytes(512 * 1024 * 1024)

export type ResolvedMinecraftJavaSaveOptions = {
  readonly maxFiles: MinecraftJavaSaveFileCountLimit
  readonly maxFileBytes: SaveMaxBytes
  readonly maxTotalBytes: SaveMaxBytes
  readonly nbt?: NbtCodecOptions
  readonly compressedNbt: MinecraftCompressedNbtOptions
  readonly region?: MinecraftRegionFilesOptions
}

type MinecraftJavaSaveValidationError = MinecraftJavaSaveError | TypeError
type RecordValue = { readonly [key: string]: unknown }
type SnapshotOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

const failedSnapshot: SnapshotOutcome = { ok: false }

const isArrayIndex = (key: string, length: number): boolean => {
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

const snapshotValue = (value: unknown, ancestors: WeakSet<object>): SnapshotOutcome => {
  if (typeof value === 'symbol' || typeof value === 'function') return failedSnapshot
  if (value === null || typeof value !== 'object') return { ok: true, value }
  if (ancestors.has(value)) return failedSnapshot
  ancestors.add(value)

  if (value instanceof Uint8Array) {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) return failedSnapshot
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !isArrayIndex(key, value.byteLength)) return failedSnapshot
    }
    const bytes: Uint8Array = Uint8Array.prototype.slice.call(value)
    ancestors.delete(value)
    return { ok: true, value: bytes }
  }

  if (Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Array.prototype && prototype !== null) return failedSnapshot
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      lengthDescriptor.enumerable ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return failedSnapshot
    }
    const length: number = lengthDescriptor.value
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1) return failedSnapshot
    for (const key of keys) {
      if (key !== 'length' && (typeof key !== 'string' || !isArrayIndex(key, length))) return failedSnapshot
    }
    const copy: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return failedSnapshot
      const element = snapshotValue(descriptor.value, ancestors)
      if (!element.ok) return failedSnapshot
      copy.push(element.value)
    }
    if (prototype === null) Object.setPrototypeOf(copy, null)
    ancestors.delete(value)
    return { ok: true, value: copy }
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return failedSnapshot
  const output: Record<string, unknown> = Object.create(prototype)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return failedSnapshot
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return failedSnapshot
    const field = snapshotValue(descriptor.value, ancestors)
    if (!field.ok) return failedSnapshot
    Object.defineProperty(output, key, {
      value: field.value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  ancestors.delete(value)
  return { ok: true, value: output }
}

const checkedValidationError = (reason: string, path?: string): MinecraftJavaSaveValidationError => {
  const error = minecraftJavaSaveError('validate', reason, path)
  return Result.isSuccess(error) ? error.success : error.failure
}

const snapshotUntrusted = (value: unknown, label: string): Result.Result<unknown, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const copied = yield* Result.try({
      try: () => snapshotValue(value, new WeakSet<object>()),
      catch: () => checkedValidationError(`${label} could not be snapshotted`),
    })
    if (!copied.ok) return yield* Result.fail(checkedValidationError(`${label} is not snapshot-safe`))
    return copied.value
  })

const isRecord = (value: unknown): value is RecordValue =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const hasOnlyKeys = (value: RecordValue, keys: ReadonlySet<string>): boolean =>
  Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.has(key))

// snapshotUntrusted has already checked density, prototype, and own data keys.
const isSnapshotArray = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value)

const isByteArray = (value: unknown): value is Uint8Array => {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) return false
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && isArrayIndex(key, value.byteLength))
}

const isSigned64 = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= -(2n ** 63n) && value <= (2n ** 63n) - 1n

const isMinecraftRegionStorage = (value: unknown): value is MinecraftRegionStorage =>
  value === 'region' || value === 'entities' || value === 'poi'

const isSafeRegionCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value * ANVIL_REGION_CHUNK_SIDE)

const ANVIL_REGION_KEYS = new Set(['chunks', 'timestamps'])

const failValidation = (reason: string, path?: string): Result.Result<never, MinecraftJavaSaveValidationError> =>
  Result.fail(checkedValidationError(reason, path))

const requireRecord = (value: unknown, label: string): Result.Result<RecordValue, MinecraftJavaSaveValidationError> =>
  isRecord(value) ? Result.succeed(value) : failValidation(`${label} must be an object`)

const requireArray = (value: unknown, label: string): Result.Result<ReadonlyArray<unknown>, MinecraftJavaSaveValidationError> =>
  isSnapshotArray(value) ? Result.succeed(value) : failValidation(`${label} must be an array`)

const requireBytes = (value: unknown, label: string): Result.Result<Uint8Array, MinecraftJavaSaveValidationError> =>
  isByteArray(value) ? Result.succeed(value) : failValidation(`${label} must be a Uint8Array`)

const requireRelativePath = (value: unknown, label: string): Result.Result<MinecraftJavaSaveFilePath, MinecraftJavaSaveValidationError> => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return failValidation(`${label} must be a non-empty path of at most 4096 characters`)
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('\u0000')) {
    return failValidation(`${label} must be a relative forward-slash path`, value)
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return failValidation(`${label} contains an unsafe path segment`, value)
  }
  return Result.mapError(
    parseMinecraftJavaSaveFilePath(value),
    () => checkedValidationError(`${label} contains an unsafe path segment`),
  )
}

const optionalSafeInteger = (
  value: unknown,
  label: string,
): Result.Result<number | undefined, MinecraftJavaSaveValidationError> => {
  if (value === undefined) return Result.succeed(undefined)
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Result.succeed(value)
    : failValidation(`${label} must be a safe integer`)
}

const resolveNbtOptions = (
  value: unknown,
  label: string,
): Result.Result<NbtCodecOptions | undefined, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    if (value === undefined) return undefined
    const record = yield* requireRecord(value, `${label} must be an object`)
    if (!hasOnlyKeys(record, new Set(['maxBytes', 'maxDepth', 'maxElements', 'maxStringBytes']))) {
      return yield* failValidation(`${label} contains an unsupported option`)
    }
    const maxBytes = yield* optionalSafeInteger(record['maxBytes'], `${label}.maxBytes`)
    const maxDepth = yield* optionalSafeInteger(record['maxDepth'], `${label}.maxDepth`)
    const maxElements = yield* optionalSafeInteger(record['maxElements'], `${label}.maxElements`)
    const maxStringBytes = yield* optionalSafeInteger(record['maxStringBytes'], `${label}.maxStringBytes`)
    return {
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(maxElements === undefined ? {} : { maxElements }),
      ...(maxStringBytes === undefined ? {} : { maxStringBytes }),
    }
  })

const resolveCompressedNbtOptions = (
  value: unknown,
): Result.Result<MinecraftCompressedNbtOptions | undefined, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    if (value === undefined) return undefined
    const record = yield* requireRecord(value, 'compressedNbt must be an object')
    if (!hasOnlyKeys(record, new Set(['maxCompressedBytes', 'maxDecompressedBytes', 'nbt']))) {
      return yield* failValidation('compressedNbt contains an unsupported option')
    }
    const maxCompressedBytes = yield* optionalSafeInteger(record['maxCompressedBytes'], 'compressedNbt.maxCompressedBytes')
    const maxDecompressedBytes = yield* optionalSafeInteger(
      record['maxDecompressedBytes'],
      'compressedNbt.maxDecompressedBytes',
    )
    const nbt = yield* resolveNbtOptions(record['nbt'], 'compressedNbt.nbt')
    return {
      ...(maxCompressedBytes === undefined ? {} : { maxCompressedBytes }),
      ...(maxDecompressedBytes === undefined ? {} : { maxDecompressedBytes }),
      ...(nbt === undefined ? {} : { nbt }),
    }
  })

const resolveRegionOptions = (
  value: unknown,
): Result.Result<MinecraftRegionFilesOptions | undefined, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    if (value === undefined) return undefined
    const record = yield* requireRecord(value, 'region must be an object')
    if (!hasOnlyKeys(record, new Set(['maxRegionBytes', 'maxExternalBytes']))) {
      return yield* failValidation('region contains an unsupported option')
    }
    const maxRegionBytes = yield* optionalSafeInteger(record['maxRegionBytes'], 'region.maxRegionBytes')
    const maxExternalBytes = yield* optionalSafeInteger(record['maxExternalBytes'], 'region.maxExternalBytes')
    return {
      ...(maxRegionBytes === undefined ? {} : { maxRegionBytes }),
      ...(maxExternalBytes === undefined ? {} : { maxExternalBytes }),
    }
  })

const assertOptionLimit = <Limit extends number>(
  name: string,
  value: unknown,
  fallback: Limit,
  make: (value: number) => Result.Result<Limit, unknown>,
): Result.Result<Limit, MinecraftJavaSaveValidationError> => {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 0) {
    return failValidation(`${name} must be a non-negative safe integer`)
  }
  return Result.mapError(make(resolved), () => checkedValidationError(`${name} must be a non-negative safe integer`))
}

export const resolveMinecraftJavaSaveOptions = (
  options: unknown,
): Result.Result<ResolvedMinecraftJavaSaveOptions, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const snapshot = yield* snapshotUntrusted(options, 'options')
    if (snapshot !== undefined && !isRecord(snapshot)) return yield* failValidation('options must be an object')
    const record = snapshot === undefined ? undefined : snapshot
    const nbt = yield* resolveNbtOptions(record?.['nbt'], 'nbt')
    const compressedNbtOptions = yield* resolveCompressedNbtOptions(record?.['compressedNbt'])
    const region = yield* resolveRegionOptions(record?.['region'])
    const compressedNbt =
      compressedNbtOptions === undefined
        ? nbt === undefined
          ? {}
          : { nbt }
        : compressedNbtOptions.nbt !== undefined || nbt === undefined
          ? compressedNbtOptions
          : { ...compressedNbtOptions, nbt }
    return {
      maxFiles: yield* assertOptionLimit(
        'maxFiles',
        record?.['maxFiles'],
        MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILES,
        (value) => toMinecraftJavaSaveFileCountLimit.result(value),
      ),
      maxFileBytes: yield* assertOptionLimit(
        'maxFileBytes',
        record?.['maxFileBytes'],
        MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILE_BYTES,
        (value) => SaveMaxBytes.result(value),
      ),
      maxTotalBytes: yield* assertOptionLimit(
        'maxTotalBytes',
        record?.['maxTotalBytes'],
        MINECRAFT_JAVA_SAVE_DEFAULT_MAX_TOTAL_BYTES,
        (value) => SaveMaxBytes.result(value),
      ),
      ...(nbt === undefined ? {} : { nbt }),
      compressedNbt,
      ...(region === undefined ? {} : { region }),
    }
  })

const assertNbtDocument = (value: unknown, label: string) =>
  isMinecraftNbtDocument(value)
    ? Result.succeed(value)
    : failValidation(`${label} must be a valid NBT document`)

const validatePlayerData = (value: unknown, index: number): Result.Result<MinecraftJavaPlayerDataFile, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `playerData ${String(index)}`)
    const playerIdValue = record['playerId']
    if (typeof playerIdValue !== 'string') {
      return yield* failValidation(`playerData ${String(index)} playerId is invalid`)
    }
    const playerId = yield* Result.mapError(
      parseMinecraftPathSegment(playerIdValue),
      () => checkedValidationError(`playerData ${String(index)} playerId is invalid`),
    )
    return {
      playerId,
      document: yield* assertNbtDocument(record['document'], `playerData ${String(index)} document`),
    }
  })

const validatePlayerJson = (
  value: unknown,
  index: number,
  label: string,
): Result.Result<MinecraftJavaPlayerJsonFile, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `${label} ${String(index)}`)
    const playerIdValue = record['playerId']
    const json = record['value']
    if (typeof playerIdValue !== 'string' || !isMinecraftJsonValue(json)) {
      return yield* failValidation(`${label} ${String(index)} is invalid`)
    }
    const playerId = yield* Result.mapError(
      parseMinecraftPathSegment(playerIdValue),
      () => checkedValidationError(`${label} ${String(index)} is invalid`),
    )
    return { playerId, value: json }
  })

const validateDataFile = (value: unknown, index: number): Result.Result<MinecraftJavaDataFile, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `dataFiles ${String(index)}`)
    const namespaceValue = record['namespace']
    const nameValue = record['name']
    if (typeof namespaceValue !== 'string' || typeof nameValue !== 'string') {
      return yield* failValidation(`dataFiles ${String(index)} namespace or name is invalid`)
    }
    const namespace = yield* Result.mapError(
      parseMinecraftPathSegment(namespaceValue),
      () => checkedValidationError(`dataFiles ${String(index)} namespace or name is invalid`),
    )
    const name = yield* Result.mapError(
      parseMinecraftRelativePath(nameValue),
      () => checkedValidationError(`dataFiles ${String(index)} namespace or name is invalid`),
    )
    const dimensionValue = record['dimension']
    const dimension = dimensionValue === undefined
      ? undefined
      : yield* Result.mapError(
          parseMinecraftDimension(dimensionValue),
          () => checkedValidationError(`dataFiles ${String(index)} dimension is invalid`),
        )
    const document = yield* assertNbtDocument(record['document'], `dataFiles ${String(index)} document`)
    return {
      namespace,
      name,
      ...(dimension === undefined ? {} : { dimension }),
      document,
    }
  })

const validateWorldClock = (
  value: unknown,
  index: number,
): Result.Result<MinecraftJavaWorldClockFile, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `worldClocks ${String(index)}`)
    const namespaceValue = record['namespace']
    const idValue = record['id']
    const json = record['value']
    if (typeof namespaceValue !== 'string' || typeof idValue !== 'string' || !isMinecraftJsonValue(json)) {
      return yield* failValidation(`worldClocks ${String(index)} is invalid`)
    }
    const namespace = yield* Result.mapError(
      parseMinecraftPathSegment(namespaceValue),
      () => checkedValidationError(`worldClocks ${String(index)} is invalid`),
    )
    const id = yield* Result.mapError(
      parseMinecraftRelativePath(idValue),
      () => checkedValidationError(`worldClocks ${String(index)} is invalid`),
    )
    return { namespace, id, value: json }
  })

const validateStructure = (
  value: unknown,
  index: number,
): Result.Result<MinecraftJavaStructureFile, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `structures ${String(index)}`)
    const namespaceValue = record['namespace']
    const nameValue = record['name']
    if (typeof namespaceValue !== 'string' || typeof nameValue !== 'string') {
      return yield* failValidation(`structures ${String(index)} namespace or name is invalid`)
    }
    const namespace = yield* Result.mapError(
      parseMinecraftPathSegment(namespaceValue),
      () => checkedValidationError(`structures ${String(index)} namespace or name is invalid`),
    )
    const name = yield* Result.mapError(
      parseMinecraftRelativePath(nameValue),
      () => checkedValidationError(`structures ${String(index)} namespace or name is invalid`),
    )
    return {
      namespace,
      name,
      document: yield* assertNbtDocument(record['document'], `structures ${String(index)} document`),
    }
  })

const validateAnvilRegion = (value: unknown, index: number): Result.Result<AnvilRegion, MinecraftJavaSaveValidationError> => {
  const invalid = (): Result.Result<AnvilRegion, MinecraftJavaSaveValidationError> =>
    failValidation(`regions ${String(index)} is invalid`)
  if (!isRecord(value) || !hasOnlyKeys(value, ANVIL_REGION_KEYS)) return invalid()
  return Result.mapError(
    anvilRegion(value['chunks'], value['timestamps']),
    () => checkedValidationError(`regions ${String(index)} is invalid`),
  )
}

const validateRegion = (value: unknown, index: number) =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `regions ${String(index)}`)
    const dimensionValue = record['dimension']
    const storage = record['storage']
    const regionXValue = record['regionX']
    const regionZValue = record['regionZ']
    if (
      !isMinecraftRegionStorage(storage) ||
      !isSafeRegionCoordinate(regionXValue) ||
      !isSafeRegionCoordinate(regionZValue)
    ) {
      return yield* failValidation(`regions ${String(index)} is invalid`)
    }
    const dimension = yield* Result.mapError(
      parseMinecraftDimension(dimensionValue),
      () => checkedValidationError(`regions ${String(index)} is invalid`),
    )
    const regionX = yield* Result.mapError(
      ChunkAxis.result(regionXValue),
      () => checkedValidationError(`regions ${String(index)} is invalid`),
    )
    const regionZ = yield* Result.mapError(
      ChunkAxis.result(regionZValue),
      () => checkedValidationError(`regions ${String(index)} is invalid`),
    )
    return {
      dimension,
      storage,
      regionX,
      regionZ,
      region: yield* validateAnvilRegion(record['region'], index),
    }
  })

const validateItems = <Item>(
  value: unknown,
  label: string,
  validateItem: (item: unknown, index: number) => Result.Result<Item, MinecraftJavaSaveValidationError>,
): Result.Result<ReadonlyArray<Item>, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const values = yield* requireArray(value, label)
    const items: Item[] = []
    for (let index = 0; index < values.length; index += 1) {
      items.push(yield* validateItem(values[index], index))
    }
    return items
  })

const validateExtraFile = (value: unknown, index: number): Result.Result<MinecraftJavaSaveFile, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const file = yield* requireRecord(value, `extraFiles ${String(index)}`)
    return {
      path: yield* requireRelativePath(file['path'], `extraFiles ${String(index)} path`),
      bytes: yield* requireBytes(file['bytes'], `extraFiles ${String(index)} bytes`),
    }
  })

export const validateMinecraftJavaSave = (
  save: unknown,
  _options: ResolvedMinecraftJavaSaveOptions,
): Result.Result<MinecraftJavaSave, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const snapshot = yield* snapshotUntrusted(save, 'save')
    const record = yield* requireRecord(snapshot, 'save')
    const level = yield* assertNbtDocument(record['level'], 'level')
    const levelBackup = record['levelBackup'] === undefined
      ? undefined
      : yield* assertNbtDocument(record['levelBackup'], 'levelBackup')
    const sessionLock = record['sessionLock']
    if (sessionLock !== undefined && !isSigned64(sessionLock)) {
      return yield* failValidation('sessionLock must be a bigint')
    }
    const icon = record['icon'] === undefined ? undefined : yield* requireBytes(record['icon'], 'icon')
    const resourcePack =
      record['resourcePack'] === undefined ? undefined : yield* requireBytes(record['resourcePack'], 'resourcePack')
    return {
      level,
      ...(levelBackup === undefined ? {} : { levelBackup }),
      ...(sessionLock === undefined ? {} : { sessionLock }),
      ...(icon === undefined ? {} : { icon }),
      playerData: yield* validateItems(record['playerData'], 'playerData', validatePlayerData),
      playerStats: yield* validateItems(record['playerStats'], 'playerStats', (value, index) =>
        validatePlayerJson(value, index, 'playerStats'),
      ),
      playerAdvancements: yield* validateItems(record['playerAdvancements'], 'playerAdvancements', (value, index) =>
        validatePlayerJson(value, index, 'playerAdvancements'),
      ),
      regions: yield* validateItems(record['regions'], 'regions', validateRegion),
      dataFiles: yield* validateItems(record['dataFiles'], 'dataFiles', validateDataFile),
      worldClocks: yield* validateItems(record['worldClocks'], 'worldClocks', validateWorldClock),
      structures: yield* validateItems(record['structures'], 'structures', validateStructure),
      ...(resourcePack === undefined ? {} : { resourcePack }),
      extraFiles: yield* validateItems(record['extraFiles'], 'extraFiles', validateExtraFile),
    }
  })

type FileLimits = Readonly<{
  maxFiles: MinecraftJavaSaveFileCountLimit
  maxFileBytes: SaveMaxBytes
  maxTotalBytes: SaveMaxBytes
}>

const readFileLimits = (value: unknown): Result.Result<FileLimits, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const options = yield* snapshotUntrusted(value, 'options')
    const record = yield* requireRecord(options, 'options must be an object')
    const maxFiles = yield* assertOptionLimit(
      'maxFiles',
      record['maxFiles'],
      MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILES,
      (limit) => toMinecraftJavaSaveFileCountLimit.result(limit),
    )
    const maxFileBytes = yield* assertOptionLimit(
      'maxFileBytes',
      record['maxFileBytes'],
      MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILE_BYTES,
      (limit) => SaveMaxBytes.result(limit),
    )
    const maxTotalBytes = yield* assertOptionLimit(
      'maxTotalBytes',
      record['maxTotalBytes'],
      MINECRAFT_JAVA_SAVE_DEFAULT_MAX_TOTAL_BYTES,
      (limit) => SaveMaxBytes.result(limit),
    )
    return { maxFiles, maxFileBytes, maxTotalBytes }
  })

export const validateMinecraftJavaSaveFiles = (
  files: unknown,
  options: ResolvedMinecraftJavaSaveOptions,
): Result.Result<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveValidationError> =>
  Result.gen(function* () {
    const limits = yield* readFileLimits(options)
    const snapshot = yield* snapshotUntrusted(files, 'files')
    const values = yield* requireArray(snapshot, 'files')
    if (values.length > limits.maxFiles) {
      return yield* failValidation(`file count exceeds maxFiles ${String(limits.maxFiles)}`)
    }
    const seen = new Set<string>()
    let totalBytes = 0
    const normalized: MinecraftJavaSaveFile[] = []
    for (let index = 0; index < values.length; index += 1) {
      const file = yield* requireRecord(values[index], `file ${String(index)}`)
      const path = yield* requireRelativePath(file['path'], `file ${String(index)} path`)
      const bytes = yield* requireBytes(file['bytes'], `file ${String(index)} bytes`)
      if (seen.has(path)) return yield* failValidation('duplicate file path', path)
      seen.add(path)
      if (bytes.byteLength > limits.maxFileBytes) {
        return yield* failValidation(`file exceeds maxFileBytes ${String(limits.maxFileBytes)}`, path)
      }
      totalBytes += bytes.byteLength
      if (totalBytes > limits.maxTotalBytes) {
        return yield* failValidation(`files exceed maxTotalBytes ${String(limits.maxTotalBytes)}`, path)
      }
      normalized.push({ path, bytes })
    }
    return normalized.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  })
