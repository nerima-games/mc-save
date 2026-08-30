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
  MinecraftJavaSave,
  MinecraftJavaSaveFile,
  MinecraftJavaSaveOptions,
  MinecraftJavaWorldClockFile,
} from './minecraft-java-save-types.js'
import { minecraftJavaSaveError, throwMinecraftJavaSaveError } from './minecraft-java-save-errors.js'
import type { MinecraftCompressedNbtOptions } from './minecraft-nbt-compression.js'
import type { MinecraftRegionFilesOptions } from './minecraft-region-files.js'
import { minecraftDimensionDirectory } from './minecraft-paths.js'
import type { MinecraftDimension, MinecraftRegionStorage } from './minecraft-paths.js'

export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILES = 100_000
export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
export const MINECRAFT_JAVA_SAVE_DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024

export type ResolvedMinecraftJavaSaveOptions = {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly nbt?: NbtCodecOptions
  readonly compressedNbt: MinecraftCompressedNbtOptions
  readonly region?: MinecraftRegionFilesOptions
}

type RecordValue = { readonly [key: string]: unknown }

const isRecord = (value: unknown): value is RecordValue => {
  if (value === null || typeof value !== 'object') return false
  try {
    if (value instanceof Uint8Array || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return false
    }
    return true
  } catch {
    return false
  }
}

const isArrayIndex = (key: string, length: number): boolean => {
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

const isDenseArray = (value: unknown): value is ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) return false
  try {
    const array = value
    const prototype = Object.getPrototypeOf(array)
    if (prototype !== Array.prototype && prototype !== null) return false
    // 'length' is not re-checked for presence or enumerability inside this loop: Array.isArray above
    // guarantees array's ultimate target is a genuine Array exotic object, whose 'length' is always an own,
    // non-enumerable, non-configurable data property (see the identical reasoning in
    // minecraft-java-save-json.ts's isJsonArray).
    const ownKeys = Reflect.ownKeys(array)
    for (const key of ownKeys) {
      if (key === 'length') continue
      if (typeof key !== 'string' || !isArrayIndex(key, array.length)) return false
      const descriptor = Object.getOwnPropertyDescriptor(array, key)
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return false
    }
    for (let index = 0; index < array.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(array, String(index))) return false
    }
    return true
  } catch {
    return false
  }
}

const isByteArray = (value: unknown): value is Uint8Array => {
  if (!(value instanceof Uint8Array)) return false
  try {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) return false
    // No per-index descriptor or hasOwnProperty re-check here: TypedArray's [[DefineOwnProperty]]
    // unconditionally rejects any attempt to redefine a valid in-bounds index as non-enumerable (even though
    // getOwnPropertyDescriptor reports configurable:true, the rejection is a TypedArray-specific override,
    // not the generic non-configurable-property rule), and a TypedArray is always densely packed -- every
    // index below byteLength is always its own property, with no way to create a hole. Reflect.ownKeys can
    // still throw for a hostile Proxy wrapping a real Uint8Array, which the surrounding try/catch covers.
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !isArrayIndex(key, value.byteLength)) return false
    }
    return true
  } catch {
    return false
  }
}

const hasOnlyKeys = (value: RecordValue, keys: ReadonlySet<string>): boolean =>
  Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.has(key))

const isUnsigned32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff

const isSigned64 = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= -(2n ** 63n) && value <= (2n ** 63n) - 1n

const isMinecraftDimension = (value: unknown): value is MinecraftDimension => {
  if (typeof value !== 'string') return false
  try {
    // @ts-expect-error -- value is an unvalidated string; minecraftDimensionDirectory's own runtime
    // guard is the validation this function exists to run, via the catch below.
    minecraftDimensionDirectory(value)
    return true
  } catch {
    return false
  }
}

const isMinecraftRegionStorage = (value: unknown): value is MinecraftRegionStorage =>
  value === 'region' || value === 'entities' || value === 'poi'

const isSafeRegionCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Number.isSafeInteger(value * ANVIL_REGION_CHUNK_SIDE)

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

const isAnvilRegion = (value: unknown): value is AnvilRegion => {
  if (!isRecord(value) || !hasOnlyKeys(value, ANVIL_REGION_KEYS)) return false
  const chunksField = value['chunks']
  const timestampsField = value['timestamps']
  if (!isDenseArray(chunksField) || !isDenseArray(timestampsField)) return false
  if (chunksField.length !== ANVIL_CHUNK_COUNT || timestampsField.length !== ANVIL_CHUNK_COUNT) return false
  const chunks: Array<AnvilChunkRecord | null> = []
  for (const chunk of chunksField) {
    if (chunk === null) {
      chunks.push(null)
    } else if (isAnvilChunk(chunk)) {
      chunks.push(chunk)
    } else {
      return false
    }
  }
  const timestamps: number[] = []
  for (const timestamp of timestampsField) {
    if (typeof timestamp !== 'number') return false
    timestamps.push(timestamp)
  }
  try {
    anvilRegion(chunks, timestamps)
    return true
  } catch {
    return false
  }
}

const requireRecord = (value: unknown, label: string): RecordValue => {
  if (isRecord(value)) return value
  throw minecraftJavaSaveError('validate', `${label} must be an object`)
}

const assertOptionLimit = (name: string, value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw minecraftJavaSaveError('validate', `${name} must be a non-negative safe integer`)
  }
  return resolved
}

export const resolveMinecraftJavaSaveOptions = (
  options: MinecraftJavaSaveOptions | undefined,
): ResolvedMinecraftJavaSaveOptions => {
  if (options !== undefined && !isRecord(options)) {
    throw minecraftJavaSaveError('validate', 'options must be an object')
  }
  const compressedNbt = options?.compressedNbt
  const mergedCompressedNbt =
    compressedNbt === undefined
      ? options?.nbt === undefined
        ? {}
        : { nbt: options.nbt }
      : options?.nbt === undefined || compressedNbt.nbt !== undefined
        ? compressedNbt
        : { ...compressedNbt, nbt: options.nbt }
  return {
    maxFiles: assertOptionLimit('maxFiles', options?.maxFiles, MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILES),
    maxFileBytes: assertOptionLimit('maxFileBytes', options?.maxFileBytes, MINECRAFT_JAVA_SAVE_DEFAULT_MAX_FILE_BYTES),
    maxTotalBytes: assertOptionLimit(
      'maxTotalBytes',
      options?.maxTotalBytes,
      MINECRAFT_JAVA_SAVE_DEFAULT_MAX_TOTAL_BYTES,
    ),
    ...(options?.nbt === undefined ? {} : { nbt: options.nbt }),
    compressedNbt: mergedCompressedNbt,
    ...(options?.region === undefined ? {} : { region: options.region }),
  }
}

const requireRelativePath = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw minecraftJavaSaveError('validate', `${label} must be a non-empty path of at most 4096 characters`)
  }
  if (value.length === 0 || value.length > 4096) {
    throw minecraftJavaSaveError('validate', `${label} must be a non-empty path of at most 4096 characters`)
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('\u0000')) {
    throw minecraftJavaSaveError('validate', `${label} must be a relative forward-slash path`, value)
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw minecraftJavaSaveError('validate', `${label} contains an unsafe path segment`, value)
  }
  return value
}

const requireBytes = (value: unknown, label: string): Uint8Array => {
  if (isByteArray(value)) return value
  throw minecraftJavaSaveError('validate', `${label} must be a Uint8Array`)
}

const requireArray = (value: unknown, label: string): ReadonlyArray<unknown> => {
  if (isDenseArray(value)) return value
  throw minecraftJavaSaveError('validate', `${label} must be an array`)
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u

const isSafeRelativeIdentifier = (value: string): boolean => {
  const segments = value.split('/')
  return segments.length > 0 && segments.every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

export const validateMinecraftJavaSaveFiles = (
  files: ReadonlyArray<MinecraftJavaSaveFile>,
  options: ResolvedMinecraftJavaSaveOptions,
): ReadonlyArray<MinecraftJavaSaveFile> => {
  const values = requireArray(files, 'files')
  if (values.length > options.maxFiles) {
    throwMinecraftJavaSaveError('validate', `file count exceeds maxFiles ${String(options.maxFiles)}`)
  }
  const seen = new Set<string>()
  let totalBytes = 0
  const normalized = values.map((value, index) => {
    const file = requireRecord(value, `file ${String(index)}`)
    const path = requireRelativePath(file['path'], `file ${String(index)} path`)
    const bytes = requireBytes(file['bytes'], `file ${String(index)} bytes`)
    if (seen.has(path)) throwMinecraftJavaSaveError('validate', 'duplicate file path', path)
    seen.add(path)
    if (bytes.byteLength > options.maxFileBytes) {
      throwMinecraftJavaSaveError('validate', `file exceeds maxFileBytes ${String(options.maxFileBytes)}`, path)
    }
    totalBytes += bytes.byteLength
    if (totalBytes > options.maxTotalBytes) {
      throwMinecraftJavaSaveError('validate', `files exceed maxTotalBytes ${String(options.maxTotalBytes)}`, path)
    }
    return { path, bytes: bytes.slice() }
  })
  return normalized.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

const assertNbtDocument = (value: unknown, label: string): void => {
  if (!isMinecraftNbtDocument(value)) throwMinecraftJavaSaveError('validate', `${label} must be a valid NBT document`)
}

const validatePlayerData = (value: unknown, index: number): void => {
  const record = requireRecord(value, `playerData ${String(index)}`)
  if (typeof record['playerId'] !== 'string' || !isSafeRelativeIdentifier(record['playerId'])) {
    throwMinecraftJavaSaveError('validate', `playerData ${String(index)} playerId is invalid`)
  }
  assertNbtDocument(record['document'], `playerData ${String(index)} document`)
}

const validatePlayerJson = (value: unknown, index: number, label: string): void => {
  const record = requireRecord(value, `${label} ${String(index)}`)
  if (
    typeof record['playerId'] !== 'string' ||
    !isSafeRelativeIdentifier(record['playerId']) ||
    !isMinecraftJsonValue(record['value'])
  ) {
    throwMinecraftJavaSaveError('validate', `${label} ${String(index)} is invalid`)
  }
}

const validateDataFile = (value: unknown, index: number): void => {
  const record = requireRecord(value, `dataFiles ${String(index)}`)
  if (
    typeof record['namespace'] !== 'string' ||
    !SAFE_SEGMENT.test(record['namespace']) ||
    typeof record['name'] !== 'string' ||
    !isSafeRelativeIdentifier(record['name'])
  ) {
    throwMinecraftJavaSaveError('validate', `dataFiles ${String(index)} namespace or name is invalid`)
  }
  if (record['dimension'] !== undefined && !isMinecraftDimension(record['dimension'])) {
    throwMinecraftJavaSaveError('validate', `dataFiles ${String(index)} dimension is invalid`)
  }
  assertNbtDocument(record['document'], `dataFiles ${String(index)} document`)
}

const validateWorldClock = (value: unknown, index: number): asserts value is MinecraftJavaWorldClockFile => {
  const record = requireRecord(value, `worldClocks ${String(index)}`)
  if (
    typeof record['namespace'] !== 'string' ||
    !SAFE_SEGMENT.test(record['namespace']) ||
    typeof record['id'] !== 'string' ||
    !isSafeRelativeIdentifier(record['id']) ||
    !isMinecraftJsonValue(record['value'])
  ) {
    throwMinecraftJavaSaveError('validate', `worldClocks ${String(index)} is invalid`)
  }
}

const validateStructure = (value: unknown, index: number): void => {
  const record = requireRecord(value, `structures ${String(index)}`)
  if (
    typeof record['namespace'] !== 'string' ||
    !SAFE_SEGMENT.test(record['namespace']) ||
    typeof record['name'] !== 'string' ||
    !isSafeRelativeIdentifier(record['name'])
  ) {
    throwMinecraftJavaSaveError('validate', `structures ${String(index)} namespace or name is invalid`)
  }
  assertNbtDocument(record['document'], `structures ${String(index)} document`)
}

const validateRegion = (value: unknown, index: number): void => {
  const record = requireRecord(value, `regions ${String(index)}`)
  if (
    !isMinecraftDimension(record['dimension']) ||
    !isMinecraftRegionStorage(record['storage']) ||
    !isSafeRegionCoordinate(record['regionX']) ||
    !isSafeRegionCoordinate(record['regionZ']) ||
    !isAnvilRegion(record['region'])
  ) {
    throwMinecraftJavaSaveError('validate', `regions ${String(index)} is invalid`)
  }
}

export function validateMinecraftJavaSave(
  save: unknown,
): asserts save is MinecraftJavaSave {
  const record = requireRecord(save, 'save')
  assertNbtDocument(record['level'], 'level')
  if (record['levelBackup'] !== undefined) assertNbtDocument(record['levelBackup'], 'levelBackup')
  if (record['sessionLock'] !== undefined && !isSigned64(record['sessionLock'])) {
    throwMinecraftJavaSaveError('validate', 'sessionLock must be a bigint')
  }
  for (const [label, value] of [
    ['icon', record['icon']],
    ['resourcePack', record['resourcePack']],
  ] as const) {
    if (value !== undefined) requireBytes(value, label)
  }

  requireArray(record['playerData'], 'playerData').forEach(validatePlayerData)
  requireArray(record['playerStats'], 'playerStats').forEach((value, index) => validatePlayerJson(value, index, 'playerStats'))
  requireArray(record['playerAdvancements'], 'playerAdvancements').forEach((value, index) =>
    validatePlayerJson(value, index, 'playerAdvancements'),
  )
  requireArray(record['regions'], 'regions').forEach(validateRegion)
  requireArray(record['dataFiles'], 'dataFiles').forEach(validateDataFile)
  requireArray(record['worldClocks'], 'worldClocks').forEach(validateWorldClock)
  requireArray(record['structures'], 'structures').forEach(validateStructure)
  requireArray(record['extraFiles'], 'extraFiles').forEach((value, index) => {
    const file = requireRecord(value, `extraFiles ${String(index)}`)
    requireRelativePath(file['path'], `extraFiles ${String(index)} path`)
    requireBytes(file['bytes'], `extraFiles ${String(index)} bytes`)
  })
}
