import { Effect } from 'effect'
import type { NbtFormatError } from './minecraft-nbt-types.js'
import type { NbtCodecOptions, NbtDocument } from './minecraft-nbt.js'
import { nbtError } from './minecraft-nbt-codec-options.js'
import { decodeNbt, encodeNbt } from './minecraft-nbt.js'
import {
  compressMinecraft,
  decompressMinecraft,
  type MinecraftCompression,
  type MinecraftCompressionError,
  type MinecraftCompressionOptions,
} from './minecraft-compression.js'
import type { MinecraftLz4Error } from './minecraft-lz4-format.js'

export type MinecraftCompressedNbtOptions = {
  readonly maxCompressedBytes?: number
  readonly maxDecompressedBytes?: number
  readonly nbt?: NbtCodecOptions
}

const compressionOptions = (
  values: { readonly maxCompressedBytes: number | undefined; readonly maxDecompressedBytes: number | undefined },
  operation: 'encode' | 'decode',
): MinecraftCompressionOptions =>
  operation === 'encode'
    ? {
        ...(values.maxDecompressedBytes === undefined ? {} : { maxInputBytes: values.maxDecompressedBytes }),
        ...(values.maxCompressedBytes === undefined ? {} : { maxOutputBytes: values.maxCompressedBytes }),
      }
    : {
        ...(values.maxCompressedBytes === undefined ? {} : { maxInputBytes: values.maxCompressedBytes }),
        ...(values.maxDecompressedBytes === undefined ? {} : { maxOutputBytes: values.maxDecompressedBytes }),
      }

export const encodeCompressedNbt = (
  document: NbtDocument,
  compression: MinecraftCompression,
  options?: MinecraftCompressedNbtOptions,
): Effect.Effect<Uint8Array, NbtFormatError | MinecraftCompressionError | MinecraftLz4Error> =>
  Effect.gen(function* () {
    const values = yield* Effect.try({
      try: () => ({ maxCompressedBytes: options?.maxCompressedBytes, maxDecompressedBytes: options?.maxDecompressedBytes, nbt: options?.nbt }),
      catch: () => nbtError('NBT compression options must be readable'),
    })
    const encoded = yield* Effect.fromResult(encodeNbt(document, values.nbt))
    return yield* compressMinecraft(encoded, compression, compressionOptions(values, 'encode'))
  })

export const decodeCompressedNbt = (
  bytes: Uint8Array,
  compression: MinecraftCompression,
  options?: MinecraftCompressedNbtOptions,
): Effect.Effect<NbtDocument, NbtFormatError | MinecraftCompressionError | MinecraftLz4Error> =>
  Effect.gen(function* () {
    const values = yield* Effect.try({
      try: () => ({ maxCompressedBytes: options?.maxCompressedBytes, maxDecompressedBytes: options?.maxDecompressedBytes, nbt: options?.nbt }),
      catch: () => nbtError('NBT compression options must be readable'),
    })
    const decompressed = yield* decompressMinecraft(bytes, compression, compressionOptions(values, 'decode'))
    return yield* Effect.fromResult(decodeNbt(decompressed, values.nbt))
  })
