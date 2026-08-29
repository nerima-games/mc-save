import type { NbtCodecOptions, NbtDocument } from './minecraft-nbt.js'
import { decodeNbt, encodeNbt } from './minecraft-nbt.js'
import {
  compressMinecraft,
  decompressMinecraft,
  type MinecraftCompression,
  type MinecraftCompressionOptions,
} from './minecraft-compression.js'

export type MinecraftCompressedNbtOptions = {
  readonly maxCompressedBytes?: number
  readonly maxDecompressedBytes?: number
  readonly nbt?: NbtCodecOptions
}

const compressionOptions = (
  options: MinecraftCompressedNbtOptions | undefined,
  operation: 'encode' | 'decode',
): MinecraftCompressionOptions =>
  operation === 'encode'
    ? {
        ...(options?.maxDecompressedBytes === undefined ? {} : { maxInputBytes: options.maxDecompressedBytes }),
        ...(options?.maxCompressedBytes === undefined ? {} : { maxOutputBytes: options.maxCompressedBytes }),
      }
    : {
        ...(options?.maxCompressedBytes === undefined ? {} : { maxInputBytes: options.maxCompressedBytes }),
        ...(options?.maxDecompressedBytes === undefined ? {} : { maxOutputBytes: options.maxDecompressedBytes }),
      }

export const encodeCompressedNbt = async (
  document: NbtDocument,
  compression: MinecraftCompression,
  options?: MinecraftCompressedNbtOptions,
): Promise<Uint8Array> =>
  compressMinecraft(encodeNbt(document, options?.nbt), compression, compressionOptions(options, 'encode'))

export const decodeCompressedNbt = async (
  bytes: Uint8Array,
  compression: MinecraftCompression,
  options?: MinecraftCompressedNbtOptions,
): Promise<NbtDocument> =>
  decodeNbt(await decompressMinecraft(bytes, compression, compressionOptions(options, 'decode')), options?.nbt)
