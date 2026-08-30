import { Data } from 'effect'
import { decodeLz4BlockStream, encodeLz4BlockStream } from './minecraft-lz4.js'

export const MINECRAFT_COMPRESSION = {
  gzip: 'gzip',
  zlib: 'zlib',
  none: 'none',
  lz4: 'lz4',
} as const

export type MinecraftCompression = keyof typeof MINECRAFT_COMPRESSION

export const MINECRAFT_COMPRESSION_MAX_BYTES = 64 * 1024 * 1024

export class MinecraftCompressionError extends Data.TaggedError('MinecraftCompressionError')<{
  readonly operation: 'encode' | 'decode'
  readonly compression: MinecraftCompression
  readonly reason: string
}> {
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
  read: () => Promise<StreamReadResult>
  releaseLock?: () => void
}

type StreamWriter = {
  write: (chunk: Uint8Array) => Promise<void>
  close: () => Promise<void>
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

function assertCompression(value: unknown, operation: MinecraftCompressionError['operation']): asserts value is MinecraftCompression {
  if (!isCompression(value)) throw compressionError(operation, 'none', `unknown compression ${String(value)}`)
}

const resolveLimit = (value: number | undefined, name: string, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): number => {
  const resolved = value ?? MINECRAFT_COMPRESSION_MAX_BYTES
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw compressionError(operation, compression, `${name} must be a non-negative safe integer`)
  }
  return resolved
}

const assertInput = (input: Uint8Array, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): void => {
  if (!(input instanceof Uint8Array)) throw compressionError(operation, compression, 'input must be a Uint8Array')
}

const assertInputLimit = (input: Uint8Array, limit: number, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): void => {
  if (input.byteLength > limit) {
    throw compressionError(operation, compression, `input exceeds maxInputBytes ${String(limit)}`)
  }
}

const assertOutputLimit = (output: Uint8Array, limit: number, compression: MinecraftCompression, operation: MinecraftCompressionError['operation']): Uint8Array => {
  if (output.byteLength > limit) {
    throw compressionError(operation, compression, `output exceeds maxOutputBytes ${String(limit)}`)
  }
  return output
}

const streamValueToBytes = (value: StreamValue): Uint8Array => {
  if (value instanceof Uint8Array) return value.slice()
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice()
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
}

const collectStreamOutput = async (
  reader: StreamReader,
  maxOutputBytes: number,
  compression: MinecraftCompression,
  operation: MinecraftCompressionError['operation'],
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- stream readers must be consumed in order.
    const result = await reader.read()
    if (result.done) break
    if (result.value === undefined) throw compressionError(operation, compression, 'stream returned no chunk')
    const chunk = streamValueToBytes(result.value)
    if (chunk.byteLength > maxOutputBytes - total) {
      throw compressionError(operation, compression, `output exceeds maxOutputBytes ${String(maxOutputBytes)}`)
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const nativeFormat = (compression: MinecraftCompression): NativeCompressionFormat =>
  compression === 'zlib' ? 'deflate' : 'gzip'

const runNativeTransform = async (
  input: Uint8Array,
  compression: MinecraftCompression,
  operation: MinecraftCompressionError['operation'],
  maxOutputBytes: number,
): Promise<Uint8Array> => {
  const Constructor = resolveStreamConstructor(operation === 'encode' ? 'CompressionStream' : 'DecompressionStream')
  if (Constructor === undefined) {
    throw compressionError(operation, compression, 'the Web Compression API is unavailable')
  }

  let reader: StreamReader | undefined
  try {
    const transform = new Constructor(nativeFormat(compression))
    const writer = transform.writable.getWriter()
    reader = transform.readable.getReader()
    await writer.write(input)
    await writer.close()
    return await collectStreamOutput(reader, maxOutputBytes, compression, operation)
  } catch (error) {
    if (error instanceof MinecraftCompressionError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw compressionError(operation, compression, reason)
  } finally {
    reader?.releaseLock?.()
  }
}

export const compressMinecraft = async (
  input: Uint8Array,
  compression: MinecraftCompression,
  options?: MinecraftCompressionOptions,
): Promise<Uint8Array> => {
  const maxInputBytes = resolveLimit(options?.maxInputBytes, 'maxInputBytes', compression, 'encode')
  const maxOutputBytes = resolveLimit(options?.maxOutputBytes, 'maxOutputBytes', compression, 'encode')
  assertCompression(compression, 'encode')
  assertInput(input, compression, 'encode')
  assertInputLimit(input, maxInputBytes, compression, 'encode')

  if (compression === 'none') return assertOutputLimit(input.slice(), maxOutputBytes, compression, 'encode')
  if (compression === 'lz4') {
    return assertOutputLimit(encodeLz4BlockStream(input, { maxBytes: maxInputBytes }), maxOutputBytes, compression, 'encode')
  }
  return runNativeTransform(input, compression, 'encode', maxOutputBytes)
}

export const decompressMinecraft = async (
  input: Uint8Array,
  compression: MinecraftCompression,
  options?: MinecraftCompressionOptions,
): Promise<Uint8Array> => {
  const maxInputBytes = resolveLimit(options?.maxInputBytes, 'maxInputBytes', compression, 'decode')
  const maxOutputBytes = resolveLimit(options?.maxOutputBytes, 'maxOutputBytes', compression, 'decode')
  assertCompression(compression, 'decode')
  assertInput(input, compression, 'decode')
  assertInputLimit(input, maxInputBytes, compression, 'decode')

  if (compression === 'none') return assertOutputLimit(input.slice(), maxOutputBytes, compression, 'decode')
  if (compression === 'lz4') {
    return decodeLz4BlockStream(input, { maxBytes: maxOutputBytes })
  }
  return runNativeTransform(input, compression, 'decode', maxOutputBytes)
}
