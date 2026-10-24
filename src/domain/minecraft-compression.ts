import { Data, Effect, Result } from 'effect'
import type * as Cause from 'effect/Cause'
import { decodeLz4BlockStream, encodeLz4BlockStream } from './minecraft-lz4.js'

export const MINECRAFT_COMPRESSION = {
  gzip: 'gzip',
  zlib: 'zlib',
  none: 'none',
  lz4: 'lz4',
} as const

export type MinecraftCompression = keyof typeof MINECRAFT_COMPRESSION

export const MINECRAFT_COMPRESSION_MAX_BYTES: number = 64 * 1024 * 1024

type MinecraftCompressionErrorFields = {
  readonly operation: 'encode' | 'decode'
  readonly compression: MinecraftCompression
  readonly reason: string
}

const MinecraftCompressionErrorBase: new (
  args: MinecraftCompressionErrorFields,
) => Cause.YieldableError & { readonly _tag: 'MinecraftCompressionError' } & Readonly<MinecraftCompressionErrorFields> =
  Data.TaggedError('MinecraftCompressionError')

export class MinecraftCompressionError extends MinecraftCompressionErrorBase {
  override get message(): string {
    return `Minecraft ${this.compression} ${this.operation} failed: ${this.reason}`
  }
}

export type MinecraftCompressionOptions = {
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
}

type NativeCompressionFormat = 'gzip' | 'deflate'

type StreamValue =
  | Uint8Array
  | ArrayBuffer
  | {
      readonly buffer: ArrayBufferLike
      readonly byteOffset: number
      readonly byteLength: number
    }

type StreamReadResult = {
  readonly done: boolean
  readonly value?: StreamValue
}

type StreamReader = {
  read: () => PromiseLike<StreamReadResult>
  releaseLock?: () => void
}

type StreamWriter = {
  write: (chunk: Uint8Array) => PromiseLike<void>
  close: () => PromiseLike<void>
}

type StreamTransform = {
  readonly readable: { getReader: () => StreamReader }
  readonly writable: { getWriter: () => StreamWriter }
}

type StreamConstructor = new (format: NativeCompressionFormat) => StreamTransform

const isStreamConstructor = (value: unknown): value is StreamConstructor => typeof value === 'function'

// CompressionStream/DecompressionStream are browser globals not declared by
// this repo's DOM-free `lib` (see tsconfig.base.json). A `declare global { var
// CompressionStream: ... }` ambient declaration works for that build, but
// collides under TS2403 with lib.dom.d.ts's own `var CompressionStream` in
// tsconfig.browser.json — every `var` declaration of one name in one scope
// must match exactly, and once it collides TypeScript resolves every use of
// the name to DOM's real, wider type instead of this file's narrower
// structural one, which is what produced the cascading errors inside
// `runNativeTransform`. Reading the property off `globalThis` at each call
// site instead of declaring an ambient var sidesteps the collision entirely,
// and — same as the removed ambient var — is read fresh on every call so a
// test's `vi.stubGlobal` still takes effect after this module has already
// been imported. `Object.getOwnPropertyDescriptor`'s first parameter is typed
// `any` in lib.es5.d.ts, so this compiles under every lib configuration this
// repo uses without a cast.
const resolveStreamConstructor = (name: 'CompressionStream' | 'DecompressionStream'): StreamConstructor | undefined => {
  const candidate: unknown = Object.getOwnPropertyDescriptor(globalThis, name)?.value
  return isStreamConstructor(candidate) ? candidate : undefined
}

const compressionError = (
  operation: MinecraftCompressionError['operation'],
  compression: MinecraftCompression,
  reason: string,
): MinecraftCompressionError => new MinecraftCompressionError({ operation, compression, reason })

const isCompression = (value: unknown): value is MinecraftCompression =>
  value === 'gzip' || value === 'zlib' || value === 'none' || value === 'lz4'

function assertCompression(value: unknown, operation: MinecraftCompressionError['operation']): Result.Result<MinecraftCompression, MinecraftCompressionError> {
  return isCompression(value)
    ? Result.succeed(value)
    : Result.fail(compressionError(operation, 'none', `unknown compression ${String(value)}`))
}

const resolveLimit = (value: number | undefined, name: string, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): Result.Result<number, MinecraftCompressionError> => {
  const resolved = value ?? MINECRAFT_COMPRESSION_MAX_BYTES
  return Number.isSafeInteger(resolved) && resolved >= 0
    ? Result.succeed(resolved)
    : Result.fail(compressionError(operation, compression, `${name} must be a non-negative safe integer`))
}

const assertInput = (input: Uint8Array, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): Result.Result<void, MinecraftCompressionError> =>
  input instanceof Uint8Array
    ? Result.succeed(undefined)
    : Result.fail(compressionError(operation, compression, 'input must be a Uint8Array'))

const assertInputLimit = (input: Uint8Array, limit: number, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): Result.Result<void, MinecraftCompressionError> =>
  input.byteLength > limit
    ? Result.fail(compressionError(operation, compression, `input exceeds maxInputBytes ${String(limit)}`))
    : Result.succeed(undefined)

const assertOutputLimit = (output: Uint8Array, limit: number, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): Result.Result<Uint8Array, MinecraftCompressionError> =>
  output.byteLength > limit
    ? Result.fail(compressionError(operation, compression, `output exceeds maxOutputBytes ${String(limit)}`))
    : Result.succeed(output)

const streamValueToBytes = (value: StreamValue, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): Result.Result<Uint8Array, MinecraftCompressionError> =>
  Result.try({
    try: () => {
      if (value instanceof Uint8Array) return value.slice()
      if (value instanceof ArrayBuffer) return new Uint8Array(value).slice()
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
    },
    catch: () => compressionError(operation, compression, 'stream chunk could not be copied'),
  })

const collectStreamOutput = (
  reader: StreamReader,
  maxOutputBytes: number,
  compression: MinecraftCompression,
  operation: MinecraftCompressionError['operation'],
): Effect.Effect<Uint8Array, MinecraftCompressionError> =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const result = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (error) => compressionError(operation, compression, error instanceof Error ? error.message : String(error)),
      })
      if (result.done) break
      if (result.value === undefined) return yield* Effect.fail(compressionError(operation, compression, 'stream returned no chunk'))
      const chunk = yield* Effect.fromResult(streamValueToBytes(result.value, compression, operation))
      if (chunk.byteLength > maxOutputBytes - total) {
        return yield* Effect.fail(compressionError(operation, compression, `output exceeds maxOutputBytes ${String(maxOutputBytes)}`))
      }
      chunks.push(chunk)
      total += chunk.byteLength
    }
    return yield* Effect.try({
      try: () => {
        const output = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          output.set(chunk, offset)
          offset += chunk.byteLength
        }
        return output
      },
      catch: () => compressionError(operation, compression, 'stream output could not be assembled'),
    })
  })

const nativeFormat = (compression: MinecraftCompression): NativeCompressionFormat =>
  compression === 'zlib' ? 'deflate' : 'gzip'

const runNativeTransform = (
  input: Uint8Array,
  compression: MinecraftCompression,
  operation: MinecraftCompressionError['operation'],
  maxOutputBytes: number,
): Effect.Effect<Uint8Array, MinecraftCompressionError> =>
  Effect.gen(function* () {
    const Constructor = resolveStreamConstructor(operation === 'encode' ? 'CompressionStream' : 'DecompressionStream')
    if (Constructor === undefined) return yield* Effect.fail(compressionError(operation, compression, 'the Web Compression API is unavailable'))

    const { reader, writer } = yield* Effect.try({
      try: () => {
        const transform = new Constructor(nativeFormat(compression))
        return { reader: transform.readable.getReader(), writer: transform.writable.getWriter() }
      },
      catch: (error) => compressionError(operation, compression, error instanceof Error ? error.message : String(error)),
    })
    const releaseLock = reader.releaseLock
    const readEffect: StreamReader = { read: () => reader.read() }
    const work = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => writer.write(input),
        catch: (error) =>
          compressionError(operation, compression, error instanceof Error ? error.message : String(error)),
      })
      yield* Effect.tryPromise({
        try: () => writer.close(),
        catch: (error) =>
          compressionError(operation, compression, error instanceof Error ? error.message : String(error)),
      })
      return yield* collectStreamOutput(readEffect, maxOutputBytes, compression, operation)
    })
    return yield*
      Effect.ensuring(
        work,
        Effect.sync(() => {
          if (typeof releaseLock === 'function') releaseLock.call(reader)
        }),
      )
  })

export const compressMinecraft = (
  input: Uint8Array,
  compression: MinecraftCompression,
  options?: MinecraftCompressionOptions,
): Effect.Effect<Uint8Array, MinecraftCompressionError | import('./minecraft-lz4-format.js').MinecraftLz4Error> =>
  Effect.gen(function* () {
    const values = yield* Effect.try({
      try: () => ({ compression, maxInputBytes: options?.maxInputBytes, maxOutputBytes: options?.maxOutputBytes }),
      catch: () => compressionError('encode', 'none', 'compression options could not be read'),
    })
    const resolvedCompression = yield* Effect.fromResult(assertCompression(values.compression, 'encode'))
    const maxInputBytes = yield* Effect.fromResult(resolveLimit(values.maxInputBytes, 'maxInputBytes', resolvedCompression, 'encode'))
    const maxOutputBytes = yield* Effect.fromResult(resolveLimit(values.maxOutputBytes, 'maxOutputBytes', resolvedCompression, 'encode'))
    yield* Effect.fromResult(assertInput(input, resolvedCompression, 'encode'))
    yield* Effect.fromResult(assertInputLimit(input, maxInputBytes, resolvedCompression, 'encode'))
    const snapshot = yield* Effect.try({
      try: () => input.slice(),
      catch: () => compressionError('encode', resolvedCompression, 'input could not be copied'),
    })

    if (resolvedCompression === 'none') return yield* Effect.fromResult(assertOutputLimit(snapshot, maxOutputBytes, resolvedCompression, 'encode'))
    if (resolvedCompression === 'lz4') {
      const output = yield* Effect.fromResult(encodeLz4BlockStream(snapshot, { maxBytes: maxInputBytes }))
      return yield* Effect.fromResult(assertOutputLimit(output, maxOutputBytes, resolvedCompression, 'encode'))
    }
    return yield* runNativeTransform(snapshot, resolvedCompression, 'encode', maxOutputBytes)
  })

export const decompressMinecraft = (
  input: Uint8Array,
  compression: MinecraftCompression,
  options?: MinecraftCompressionOptions,
): Effect.Effect<Uint8Array, MinecraftCompressionError | import('./minecraft-lz4-format.js').MinecraftLz4Error> =>
  Effect.gen(function* () {
    const values = yield* Effect.try({
      try: () => ({ compression, maxInputBytes: options?.maxInputBytes, maxOutputBytes: options?.maxOutputBytes }),
      catch: () => compressionError('decode', 'none', 'compression options could not be read'),
    })
    const resolvedCompression = yield* Effect.fromResult(assertCompression(values.compression, 'decode'))
    const maxInputBytes = yield* Effect.fromResult(resolveLimit(values.maxInputBytes, 'maxInputBytes', resolvedCompression, 'decode'))
    const maxOutputBytes = yield* Effect.fromResult(resolveLimit(values.maxOutputBytes, 'maxOutputBytes', resolvedCompression, 'decode'))
    yield* Effect.fromResult(assertInput(input, resolvedCompression, 'decode'))
    yield* Effect.fromResult(assertInputLimit(input, maxInputBytes, resolvedCompression, 'decode'))
    const snapshot = yield* Effect.try({
      try: () => input.slice(),
      catch: () => compressionError('decode', resolvedCompression, 'input could not be copied'),
    })

    if (resolvedCompression === 'none') return yield* Effect.fromResult(assertOutputLimit(snapshot, maxOutputBytes, resolvedCompression, 'decode'))
    if (resolvedCompression === 'lz4') {
      return yield* Effect.fromResult(decodeLz4BlockStream(snapshot, { maxBytes: maxOutputBytes }))
    }
    return yield* runNativeTransform(snapshot, resolvedCompression, 'decode', maxOutputBytes)
  })
