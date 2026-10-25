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
  readonly maxCompressedBytes?: unknown
  readonly maxDecompressedBytes?: unknown
  readonly nbt?: NbtCodecOptions
}

const compressionOptions = (
  values: { readonly maxCompressedBytes: unknown; readonly maxDecompressedBytes: unknown },
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
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Effect.fail(nbtError('NBT compression options must be readable'))
    }
    const values = yield* Effect.try({
      try: () => options === undefined
        ? { maxCompressedBytes: undefined, maxDecompressedBytes: undefined, nbt: undefined }
        : {
            maxCompressedBytes: Reflect.get(options, 'maxCompressedBytes'),
            maxDecompressedBytes: Reflect.get(options, 'maxDecompressedBytes'),
            nbt: Reflect.get(options, 'nbt'),
          },
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
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Effect.fail(nbtError('NBT compression options must be readable'))
    }
    const values = yield* Effect.try({
      try: () => options === undefined
        ? { maxCompressedBytes: undefined, maxDecompressedBytes: undefined, nbt: undefined }
        : {
            maxCompressedBytes: Reflect.get(options, 'maxCompressedBytes'),
            maxDecompressedBytes: Reflect.get(options, 'maxDecompressedBytes'),
            nbt: Reflect.get(options, 'nbt'),
          },
      catch: () => nbtError('NBT compression options must be readable'),
    })
    const decompressed = yield* decompressMinecraft(bytes, compression, compressionOptions(values, 'decode'))
    return yield* Effect.fromResult(decodeNbt(decompressed, values.nbt))
  })
