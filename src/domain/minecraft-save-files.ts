/* oxlint-disable no-bitwise -- Minecraft session.lock bounds are signed 64-bit fields. */
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

export const encodeMinecraftNbtFile = async (
  document: NbtDocument,
  options?: MinecraftNbtFileOptions,
): Promise<Uint8Array> =>
  encodeCompressedNbt(document, options?.compression ?? MINECRAFT_NBT_FILE_COMPRESSION, options)

export const decodeMinecraftNbtFile = async (
  bytes: Uint8Array,
  options?: MinecraftNbtFileOptions,
): Promise<NbtDocument> =>
  decodeCompressedNbt(bytes, options?.compression ?? MINECRAFT_NBT_FILE_COMPRESSION, options)

export const encodeMinecraftSessionLock = (value: bigint): Uint8Array => {
  if (typeof value !== 'bigint') throw sessionLockError('value must be a bigint')
  if (value < SESSION_LOCK_MIN || value > SESSION_LOCK_MAX) {
    throw sessionLockError('value must fit in a signed 64-bit integer')
  }

  const bytes = new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES)
  new DataView(bytes.buffer).setBigInt64(0, value, false)
  return bytes
}

export const decodeMinecraftSessionLock = (bytes: Uint8Array): bigint => {
  if (!(bytes instanceof Uint8Array)) throw sessionLockError('bytes must be a Uint8Array')
  if (bytes.byteLength !== MINECRAFT_SESSION_LOCK_BYTES) {
    throw sessionLockError(`bytes must be exactly ${String(MINECRAFT_SESSION_LOCK_BYTES)} bytes`)
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(0, false)
}
