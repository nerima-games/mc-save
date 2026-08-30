import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MINECRAFT_COMPRESSION_MAX_BYTES,
  MinecraftCompressionError,
  compressMinecraft,
  decompressMinecraft,
} from '../src/domain/minecraft-compression.js'

// `ArrayBufferLike` (not `ArrayBuffer`) so `Uint8Array.prototype.buffer` — typed `ArrayBufferLike`,
// since a Uint8Array can in principle back onto a SharedArrayBuffer — is directly assignable here with
// no narrowing needed. This fake only ever sees buffers it constructed itself from plain Uint8Arrays.
type FakeStreamValue =
  | Uint8Array
  | ArrayBufferLike
  | {
      readonly buffer: ArrayBufferLike
      readonly byteOffset: number
      readonly byteLength: number
    }

// Widens a value's static type to `T` with NO runtime transformation and no type assertion:
// `Record<string, any>` indexing is `any` by construction, assignable anywhere with zero compiler
// complaint. Used to hand a type-invalid input to a strictly-typed function, so the test proves the
// function's own runtime check — not the type checker — rejects it.
const widen = <T,>(value: unknown): T => {
  const bag: Record<string, any> = {}
  bag['value'] = value
  return bag['value']
}

type FakeStreamReader = {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: FakeStreamValue }>
  readonly releaseLock: () => void
}

class FakeCompressionStream {
  static outputSequences: FakeStreamValue[][] = []

  readonly readable: { getReader: () => FakeStreamReader } = {
    getReader: () => {
      const values = FakeCompressionStream.outputSequences.shift() ?? []
      let index = 0
      return {
        read: async () => {
          const value = values[index]
          index += 1
          return value === undefined ? { done: true } : { done: false, value }
        },
        releaseLock: () => undefined,
      }
    },
  }

  readonly writable = {
    getWriter: () => ({
      write: async (_chunk: Uint8Array) => undefined,
      close: async () => undefined,
    }),
  }

  readonly format: 'gzip' | 'deflate'

  constructor(format: 'gzip' | 'deflate') {
    this.format = format
  }
}

class ThrowingCompressionStream {
  readonly readable = { getReader: () => ({ read: async () => ({ done: true }) }) }
  readonly writable = {
    getWriter: () => ({
      write: async () => {
        throw new Error('fake transform failure')
      },
      close: async () => undefined,
    }),
  }

  readonly format: 'gzip' | 'deflate'

  constructor(format: 'gzip' | 'deflate') {
    this.format = format
  }
}

const nonErrorFailure = (): unknown => 'fake string failure'

class NonErrorThrowingCompressionStream extends ThrowingCompressionStream {
  override readonly writable = {
    getWriter: () => ({
      write: async () => {
        throw nonErrorFailure()
      },
      close: async () => undefined,
    }),
  }
}

const expectCompressionError = async (operation: Promise<unknown>): Promise<void> => {
  await expect(operation).rejects.toThrowError(MinecraftCompressionError)
}

afterEach(() => {
  FakeCompressionStream.outputSequences = []
  vi.unstubAllGlobals()
})

describe('Minecraft compression API', () => {
  it.each(['gzip', 'zlib', 'none', 'lz4'] as const)('round-trips %s data', async (compression) => {
    const input = Uint8Array.from({ length: 10_000 }, (_, index) => (index * 17) % 256)
    const encoded = await compressMinecraft(input, compression)

    expect(encoded).not.toBe(input)
    expect(await decompressMinecraft(encoded, compression)).toStrictEqual(input)
  })

  it('copies uncompressed values and applies input and output limits', async () => {
    const input = new Uint8Array([1, 2, 3])
    const copied = await compressMinecraft(input, 'none')
    copied[0] = 99
    expect(input[0]).toBe(1)
    expect(MINECRAFT_COMPRESSION_MAX_BYTES).toBe(64 * 1024 * 1024)

    await expectCompressionError(compressMinecraft(input, 'none', { maxInputBytes: 2 }))
    await expectCompressionError(compressMinecraft(input, 'none', { maxOutputBytes: 2 }))
    await expectCompressionError(decompressMinecraft(input, 'none', { maxInputBytes: 2 }))
    await expectCompressionError(decompressMinecraft(input, 'none', { maxOutputBytes: 2 }))
    await expectCompressionError(compressMinecraft(input, 'none', { maxInputBytes: -1 }))
    await expectCompressionError(compressMinecraft(input, 'none', { maxOutputBytes: Number.NaN }))
    await expectCompressionError(decompressMinecraft(input, 'none', { maxInputBytes: Number.MAX_SAFE_INTEGER + 1 }))
  })

  it('wraps invalid inputs, compression names, and malformed native frames', async () => {
    expect(
      new MinecraftCompressionError({ operation: 'decode', compression: 'gzip', reason: 'bad frame' }).message,
    ).toBe('Minecraft gzip decode failed: bad frame')
    await expectCompressionError(compressMinecraft(widen(null), 'none'))
    await expectCompressionError(decompressMinecraft(widen(null), 'none'))
    await expectCompressionError(compressMinecraft(new Uint8Array(), widen('invalid')))
    await expectCompressionError(decompressMinecraft(new Uint8Array(), widen('invalid')))
    await expectCompressionError(decompressMinecraft(new Uint8Array([1, 2, 3]), 'gzip'))
    await expectCompressionError(decompressMinecraft(new Uint8Array([1, 2, 3]), 'zlib'))
  })

  it('reports unavailable Web Compression APIs', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    await expectCompressionError(compressMinecraft(new Uint8Array([1]), 'gzip'))

    vi.stubGlobal('DecompressionStream', undefined)
    await expectCompressionError(decompressMinecraft(new Uint8Array([1]), 'gzip'))
  })

  it('collects native stream output from byte arrays, buffers, and views', async () => {
    const buffer = new Uint8Array([0, 2, 0]).buffer
    FakeCompressionStream.outputSequences = [
      [
        Uint8Array.from([1]),
        buffer,
        { buffer: Uint8Array.from([3, 4, 5]).buffer, byteOffset: 1, byteLength: 2 },
      ],
    ]
    vi.stubGlobal('CompressionStream', FakeCompressionStream)

    expect(await compressMinecraft(new Uint8Array([9]), 'gzip')).toStrictEqual(new Uint8Array([1, 0, 2, 0, 4, 5]))
    expect(FakeCompressionStream.outputSequences).toHaveLength(0)
  })

  it('enforces native output limits and wraps transform failures', async () => {
    FakeCompressionStream.outputSequences = [[Uint8Array.from([1, 2, 3])]]
    vi.stubGlobal('CompressionStream', FakeCompressionStream)
    await expectCompressionError(compressMinecraft(new Uint8Array([9]), 'gzip', { maxOutputBytes: 2 }))

    vi.stubGlobal('CompressionStream', ThrowingCompressionStream)
    await expectCompressionError(compressMinecraft(new Uint8Array([9]), 'gzip'))

    vi.stubGlobal('CompressionStream', NonErrorThrowingCompressionStream)
    await expectCompressionError(compressMinecraft(new Uint8Array([9]), 'gzip'))
  })

  it('rejects streams that return no chunk', async () => {
    vi.stubGlobal('CompressionStream', class extends FakeCompressionStream {
      constructor(format: 'gzip' | 'deflate') {
        super(format)
        this.readable.getReader = () => ({
          read: async () => ({ done: false }),
          releaseLock: () => undefined,
        })
      }
    })
    await expectCompressionError(compressMinecraft(new Uint8Array([9]), 'gzip'))
  })
})
