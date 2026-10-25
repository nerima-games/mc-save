import { ChunkAxis } from '@nerima-games/mc-kernel/domain/coordinates'
import { Result } from 'effect'
import type { NbtCodecOptions } from './minecraft-nbt-codec.js'
import {
  ANVIL_CHUNK_COUNT,
  ANVIL_REGION_CHUNK_SIDE,
  anvilRegion,
  type AnvilChunkRecord,
  type AnvilRegion,
} from './anvil-region.js'
import { isMinecraftJsonValue } from './minecraft-java-save-json.js'
import { isMinecraftNbtDocument } from './minecraft-nbt-validation.js'
import type {
  MinecraftJavaDataFile,
  MinecraftJavaPlayerDataFile,
  MinecraftJavaPlayerJsonFile,
  MinecraftJavaSave,
  MinecraftJavaSaveFile,
  MinecraftJavaSaveOptions,
  MinecraftJavaStructureFile,
  MinecraftJavaWorldClockFile,
} from './minecraft-java-save-types.js'
import { minecraftJavaSaveError, type MinecraftJavaSaveError } from './minecraft-java-save-errors.js'
import type { MinecraftCompressedNbtOptions } from './minecraft-nbt-compression.js'
import type { MinecraftRegionFilesOptions } from './minecraft-region-files.js'
import { minecraftDimensionDirectory } from './minecraft-paths.js'
import type { MinecraftDimension, MinecraftRegionStorage } from './minecraft-paths.js'

export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILES = 100_000
export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILE_BYTES: number = 64 * 1024 * 1024
export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_TOTAL_BYTES: number = 512 * 1024 * 1024

export type ResolvedMinecraftJavaSaveOptions = {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly nbt?: NbtCodecOptions
  readonly compressedNbt: MinecraftCompressedNbtOptions
  readonly region?: MinecraftRegionFilesOptions
}

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

const snapshotUntrusted = (value: unknown, label: string): Result.Result<unknown, MinecraftJavaSaveError> =>
  Result.gen(function* () {
    const copied = yield* Result.try({
      try: () => snapshotValue(value, new WeakSet<object>()),
      catch: () => minecraftJavaSaveError('validate', `${label} could not be snapshotted`),
    })
    if (!copied.ok) return yield* Result.fail(minecraftJavaSaveError('validate', `${label} is not snapshot-safe`))
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

const isUnsigned32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff

const isSigned64 = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= -(2n ** 63n) && value <= (2n ** 63n) - 1n

const isMinecraftDimension = (value: unknown): value is MinecraftDimension =>
  typeof value === 'string' && Result.isSuccess(minecraftDimensionDirectory(value))

const isMinecraftRegionStorage = (value: unknown): value is MinecraftRegionStorage =>
  value === 'region' || value === 'entities' || value === 'poi'

const isSafeRegionCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value * ANVIL_REGION_CHUNK_SIDE)

const ANVIL_CHUNK_KEYS = new Set(['localX', 'localZ', 'timestamp', 'compression', 'payload', 'external'])
const ANVIL_REGION_KEYS = new Set(['chunks', 'timestamps'])

const isAnvilChunk = (value: unknown): value is AnvilChunkRecord => {
  if (!isRecord(value) || !hasOnlyKeys(value, ANVIL_CHUNK_KEYS)) return false
  return (
    Number.isInteger(value['localX']) &&
    Number.isInteger(value['localZ']) &&
    isUnsigned32(value['timestamp']) &&
    (value['compression'] === 'gzip' ||
      value['compression'] === 'zlib' ||
      value['compression'] === 'none' ||
      value['compression'] === 'lz4' ||
      value['compression'] === 'custom') &&
    isByteArray(value['payload']) &&
    (value['external'] === undefined || typeof value['external'] === 'boolean')
  )
}

const failValidation = (reason: string, path?: string): Result.Result<never, MinecraftJavaSaveError> =>
  Result.fail(minecraftJavaSaveError('validate', reason, path))

const requireRecord = (value: unknown, label: string): Result.Result<RecordValue, MinecraftJavaSaveError> =>
  isRecord(value) ? Result.succeed(value) : failValidation(`${label} must be an object`)

const requireArray = (value: unknown, label: string): Result.Result<ReadonlyArray<unknown>, MinecraftJavaSaveError> =>
  isSnapshotArray(value) ? Result.succeed(value) : failValidation(`${label} must be an array`)

const requireBytes = (value: unknown, label: string): Result.Result<Uint8Array, MinecraftJavaSaveError> =>
  isByteArray(value) ? Result.succeed(value) : failValidation(`${label} must be a Uint8Array`)

const requireRelativePath = (value: unknown, label: string): Result.Result<string, MinecraftJavaSaveError> => {
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
  return Result.succeed(value)
}

const optionalSafeInteger = (
  value: unknown,
  label: string,
): Result.Result<number | undefined, MinecraftJavaSaveError> => {
  if (value === undefined) return Result.succeed(undefined)
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Result.succeed(value)
    : failValidation(`${label} must be a safe integer`)
}

const resolveNbtOptions = (
  value: unknown,
  label: string,
): Result.Result<NbtCodecOptions | undefined, MinecraftJavaSaveError> =>
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
): Result.Result<MinecraftCompressedNbtOptions | undefined, MinecraftJavaSaveError> =>
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
): Result.Result<MinecraftRegionFilesOptions | undefined, MinecraftJavaSaveError> =>
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

const assertOptionLimit = (name: string, value: unknown, fallback: number): Result.Result<number, MinecraftJavaSaveError> => {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 0) {
    return failValidation(`${name} must be a non-negative safe integer`)
  }
  return Result.succeed(resolved)
}

export const resolveMinecraftJavaSaveOptions = (
  options: MinecraftJavaSaveOptions | undefined,
): Result.Result<ResolvedMinecraftJavaSaveOptions, MinecraftJavaSaveError> =>
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
      ),
      maxFileBytes: yield* assertOptionLimit(
        'maxFileBytes',
        record?.['maxFileBytes'],
        MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILE_BYTES,
      ),
      maxTotalBytes: yield* assertOptionLimit(
        'maxTotalBytes',
        record?.['maxTotalBytes'],
        MINECRAFT_JAVA_SAVE_DEFAULT_MAX_TOTAL_BYTES,
      ),
      ...(nbt === undefined ? {} : { nbt }),
      compressedNbt,
      ...(region === undefined ? {} : { region }),
    }
  })

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u

const isSafeRelativeIdentifier = (value: string): boolean => {
  const segments = value.split('/')
  return segments.length > 0 && segments.every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

const assertNbtDocument = (value: unknown, label: string) =>
  isMinecraftNbtDocument(value)
    ? Result.succeed(value)
    : failValidation(`${label} must be a valid NBT document`)

const validatePlayerData = (value: unknown, index: number): Result.Result<MinecraftJavaPlayerDataFile, MinecraftJavaSaveError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `playerData ${String(index)}`)
    const playerId = record['playerId']
    if (typeof playerId !== 'string' || !isSafeRelativeIdentifier(playerId)) {
      return yield* failValidation(`playerData ${String(index)} playerId is invalid`)
    }
    return {
      playerId,
      document: yield* assertNbtDocument(record['document'], `playerData ${String(index)} document`),
    }
  })

const validatePlayerJson = (
  value: unknown,
  index: number,
  label: string,
): Result.Result<MinecraftJavaPlayerJsonFile, MinecraftJavaSaveError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `${label} ${String(index)}`)
    const playerId = record['playerId']
    const json = record['value']
    if (typeof playerId !== 'string' || !isSafeRelativeIdentifier(playerId) || !isMinecraftJsonValue(json)) {
      return yield* failValidation(`${label} ${String(index)} is invalid`)
    }
    return { playerId, value: json }
  })

const validateDataFile = (value: unknown, index: number): Result.Result<MinecraftJavaDataFile, MinecraftJavaSaveError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `dataFiles ${String(index)}`)
    const namespace = record['namespace']
    const name = record['name']
    if (
      typeof namespace !== 'string' ||
      !SAFE_SEGMENT.test(namespace) ||
      typeof name !== 'string' ||
      !isSafeRelativeIdentifier(name)
    ) {
      return yield* failValidation(`dataFiles ${String(index)} namespace or name is invalid`)
    }
    const dimensionValue = record['dimension']
    if (dimensionValue !== undefined && !isMinecraftDimension(dimensionValue)) {
      return yield* failValidation(`dataFiles ${String(index)} dimension is invalid`)
    }
    const document = yield* assertNbtDocument(record['document'], `dataFiles ${String(index)} document`)
    return {
      namespace,
      name,
      ...(dimensionValue === undefined ? {} : { dimension: dimensionValue }),
      document,
    }
  })

const validateWorldClock = (
  value: unknown,
  index: number,
): Result.Result<MinecraftJavaWorldClockFile, MinecraftJavaSaveError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `worldClocks ${String(index)}`)
    const namespace = record['namespace']
    const id = record['id']
    const json = record['value']
    if (
      typeof namespace !== 'string' ||
      !SAFE_SEGMENT.test(namespace) ||
      typeof id !== 'string' ||
      !isSafeRelativeIdentifier(id) ||
      !isMinecraftJsonValue(json)
    ) {
      return yield* failValidation(`worldClocks ${String(index)} is invalid`)
    }
    return { namespace, id, value: json }
  })

const validateStructure = (
  value: unknown,
  index: number,
): Result.Result<MinecraftJavaStructureFile, MinecraftJavaSaveError> =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `structures ${String(index)}`)
    const namespace = record['namespace']
    const name = record['name']
    if (
      typeof namespace !== 'string' ||
      !SAFE_SEGMENT.test(namespace) ||
      typeof name !== 'string' ||
      !isSafeRelativeIdentifier(name)
    ) {
      return yield* failValidation(`structures ${String(index)} namespace or name is invalid`)
    }
    return {
      namespace,
      name,
      document: yield* assertNbtDocument(record['document'], `structures ${String(index)} document`),
    }
  })

const validateAnvilRegion = (value: unknown, index: number): Result.Result<AnvilRegion, MinecraftJavaSaveError> => {
  const invalid = (): Result.Result<AnvilRegion, MinecraftJavaSaveError> =>
    failValidation(`regions ${String(index)} is invalid`)
  if (!isRecord(value) || !hasOnlyKeys(value, ANVIL_REGION_KEYS)) return invalid()
  const chunksField = value['chunks']
  const timestampsField = value['timestamps']
  if (!isSnapshotArray(chunksField) || !isSnapshotArray(timestampsField)) return invalid()
  if (chunksField.length !== ANVIL_CHUNK_COUNT || timestampsField.length !== ANVIL_CHUNK_COUNT) return invalid()
  const chunks: Array<AnvilChunkRecord | null> = []
  for (const chunk of chunksField) {
    if (chunk === null) chunks.push(null)
    else if (isAnvilChunk(chunk)) chunks.push(chunk)
    else return invalid()
  }
  const timestamps: number[] = []
  for (const timestamp of timestampsField) {
    if (typeof timestamp !== 'number') return invalid()
    timestamps.push(timestamp)
  }
  return Result.mapError(anvilRegion(chunks, timestamps), () => minecraftJavaSaveError('validate', `regions ${String(index)} is invalid`))
}

const validateRegion = (value: unknown, index: number) =>
  Result.gen(function* () {
    const record = yield* requireRecord(value, `regions ${String(index)}`)
    const dimension = record['dimension']
    const storage = record['storage']
    const regionXValue = record['regionX']
    const regionZValue = record['regionZ']
    if (
      !isMinecraftDimension(dimension) ||
      !isMinecraftRegionStorage(storage) ||
      !isSafeRegionCoordinate(regionXValue) ||
      !isSafeRegionCoordinate(regionZValue)
    ) {
      return yield* failValidation(`regions ${String(index)} is invalid`)
    }
    const regionX = yield* Result.mapError(
      ChunkAxis.result(regionXValue),
      () => minecraftJavaSaveError('validate', `regions ${String(index)} is invalid`),
    )
    const regionZ = yield* Result.mapError(
      ChunkAxis.result(regionZValue),
      () => minecraftJavaSaveError('validate', `regions ${String(index)} is invalid`),
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
  validateItem: (item: unknown, index: number) => Result.Result<Item, MinecraftJavaSaveError>,
): Result.Result<ReadonlyArray<Item>, MinecraftJavaSaveError> =>
  Result.gen(function* () {
    const values = yield* requireArray(value, label)
    const items: Item[] = []
    for (let index = 0; index < values.length; index += 1) {
      items.push(yield* validateItem(values[index], index))
    }
    return items
  })

const validateExtraFile = (value: unknown, index: number): Result.Result<MinecraftJavaSaveFile, MinecraftJavaSaveError> =>
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
): Result.Result<MinecraftJavaSave, MinecraftJavaSaveError> =>
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

type FileLimits = Readonly<{ maxFiles: number; maxFileBytes: number; maxTotalBytes: number }>

const readFileLimits = (value: unknown): Result.Result<FileLimits, MinecraftJavaSaveError> =>
  Result.gen(function* () {
    const options = yield* snapshotUntrusted(value, 'options')
    const record = yield* requireRecord(options, 'options must be an object')
    const maxFiles = yield* assertOptionLimit('maxFiles', record['maxFiles'], MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILES)
    const maxFileBytes = yield* assertOptionLimit(
      'maxFileBytes',
      record['maxFileBytes'],
      MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILE_BYTES,
    )
    const maxTotalBytes = yield* assertOptionLimit(
      'maxTotalBytes',
      record['maxTotalBytes'],
      MINECRAFT_JAVA_SAVE_DEFAULT_MAX_TOTAL_BYTES,
    )
    return { maxFiles, maxFileBytes, maxTotalBytes }
  })

export const validateMinecraftJavaSaveFiles = (
  files: ReadonlyArray<MinecraftJavaSaveFile>,
  options: ResolvedMinecraftJavaSaveOptions,
): Result.Result<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveError> =>
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
