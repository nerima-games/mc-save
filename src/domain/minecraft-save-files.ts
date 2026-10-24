/* oxlint-disable no-bitwise -- Minecraft session.lock bounds are signed 64-bit fields. */
import { Effect, Result } from 'effect'
import type { MinecraftCompressionError } from './minecraft-compression.js'
import type { MinecraftLz4Error } from './minecraft-lz4-format.js'
import type { NbtFormatError } from './minecraft-nbt-types.js'
import type { MinecraftCompression } from './minecraft-compression.js'
import type { NbtDocument } from './minecraft-nbt.js'
import {
  decodeCompressedNbt,
  encodeCompressedNbt,
  type MinecraftCompressedNbtOptions,
} from './minecraft-nbt-compression.js'

export const MINECRAFT_NBT_FILE_COMPRESSION = 'gzip' as const
export const MINECRAFT_SESSION_LOCK_BYTES = 8

export type MinecraftNbtFileOptions = MinecraftCompressedNbtOptions & {
  readonly compression?: MinecraftCompression
}

const SESSION_LOCK_MIN = -(1n << 63n)
const SESSION_LOCK_MAX = (1n << 63n) - 1n

const sessionLockError = (reason: string): TypeError => new TypeError(`Minecraft session.lock ${reason}`)

export const encodeMinecraftNbtFile = (
  document: NbtDocument,
  options?: MinecraftNbtFileOptions,
): Effect.Effect<Uint8Array, TypeError | NbtFormatError | MinecraftCompressionError | MinecraftLz4Error> =>
  Effect.gen(function* () {
    const values = yield* Effect.try({
      try: () => ({ compression: options?.compression ?? MINECRAFT_NBT_FILE_COMPRESSION, options }),
      catch: () => new TypeError('Minecraft NBT file options could not be read'),
    })
    return yield* encodeCompressedNbt(document, values.compression, values.options)
  })

export const decodeMinecraftNbtFile = (
  bytes: Uint8Array,
  options?: MinecraftNbtFileOptions,
): Effect.Effect<NbtDocument, TypeError | NbtFormatError | MinecraftCompressionError | MinecraftLz4Error> =>
  Effect.gen(function* () {
    const values = yield* Effect.try({
      try: () => ({ compression: options?.compression ?? MINECRAFT_NBT_FILE_COMPRESSION, options }),
      catch: () => new TypeError('Minecraft NBT file options could not be read'),
    })
    return yield* decodeCompressedNbt(bytes, values.compression, values.options)
  })

export const encodeMinecraftSessionLock = (value: bigint): Result.Result<Uint8Array, TypeError> => {
  if (typeof value !== 'bigint') return Result.fail(sessionLockError('value must be a bigint'))
  if (value < SESSION_LOCK_MIN || value > SESSION_LOCK_MAX) {
    return Result.fail(sessionLockError('value must fit in a signed 64-bit integer'))
  }
  return Result.try({
    try: () => {
      const bytes = new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES)
      new DataView(bytes.buffer).setBigInt64(0, value, false)
      return bytes
    },
    catch: (error) => error instanceof TypeError ? error : sessionLockError(String(error)),
  })
}

export const decodeMinecraftSessionLock = (bytes: Uint8Array): Result.Result<bigint, TypeError> =>
  Result.gen(function* () {
    if (!(bytes instanceof Uint8Array)) return yield* Result.fail(sessionLockError('bytes must be a Uint8Array'))
    const snapshot = yield* Result.try({
      try: () => bytes.slice(),
      catch: (error) => error instanceof TypeError ? error : sessionLockError(String(error)),
    })
    if (snapshot.byteLength !== MINECRAFT_SESSION_LOCK_BYTES) {
      return yield* Result.fail(sessionLockError(`bytes must be exactly ${String(MINECRAFT_SESSION_LOCK_BYTES)} bytes`))
    }
    return yield* Result.try({
      try: () => new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength).getBigInt64(0, false),
      catch: (error) => error instanceof TypeError ? error : sessionLockError(String(error)),
    })
  })
