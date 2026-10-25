/* oxlint-disable no-bitwise -- tests construct signed 64-bit session-lock boundaries. */
import { Effect, Result } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  MINECRAFT_NBT_FILE_COMPRESSION,
  MINECRAFT_SESSION_LOCK_BYTES,
  decodeMinecraftNbtFile as decodeMinecraftNbtFileEffect,
  decodeMinecraftSessionLock as decodeMinecraftSessionLockResult,
  encodeMinecraftNbtFile as encodeMinecraftNbtFileEffect,
  encodeMinecraftSessionLock as encodeMinecraftSessionLockResult,
} from '../src/domain/minecraft-save-files.js'
import {
  nbtByte as nbtByteResult,
  nbtCompound as nbtCompoundResult,
  nbtDocument as nbtDocumentResult,
  nbtString as nbtStringResult,
} from '../src/domain/minecraft-nbt.js'

const unwrapResult = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const nbtByte = (...args: Parameters<typeof nbtByteResult>) => unwrapResult(nbtByteResult(...args))
const nbtCompound = (...args: Parameters<typeof nbtCompoundResult>) => unwrapResult(nbtCompoundResult(...args))
const nbtDocument = (...args: Parameters<typeof nbtDocumentResult>) => unwrapResult(nbtDocumentResult(...args))
const nbtString = (...args: Parameters<typeof nbtStringResult>) => unwrapResult(nbtStringResult(...args))
const decodeMinecraftSessionLock = (...args: Parameters<typeof decodeMinecraftSessionLockResult>) => Result.getOrThrow(decodeMinecraftSessionLockResult(...args))
const encodeMinecraftSessionLock = (...args: Parameters<typeof encodeMinecraftSessionLockResult>) => Result.getOrThrow(encodeMinecraftSessionLockResult(...args))
const decodeMinecraftNbtFile = (...args: Parameters<typeof decodeMinecraftNbtFileEffect>) => Effect.runPromise(decodeMinecraftNbtFileEffect(...args))
const encodeMinecraftNbtFile = (...args: Parameters<typeof encodeMinecraftNbtFileEffect>) => Effect.runPromise(encodeMinecraftNbtFileEffect(...args))

const original = nbtDocument(
  '',
  nbtCompound([
    ['byte', nbtByte(-12)],
    ['string', nbtString('text\0é漢😀')],
    ['nested', nbtCompound([['value', nbtString('nested')]])],
  ]),
)

describe('Minecraft save files', () => {
  it('uses gzip by default for compressed NBT files', async () => {
    expect(MINECRAFT_NBT_FILE_COMPRESSION).toBe('gzip')

    const encoded = await encodeMinecraftNbtFile(original)

    expect(encoded.byteLength).toBeGreaterThan(0)
    expect(await decodeMinecraftNbtFile(encoded)).toStrictEqual(original)
  })

  it('passes explicit compression and limits to the shared NBT codec', async () => {
    const plain = await encodeMinecraftNbtFile(original, { compression: 'none' })
    const options = {
      compression: 'none' as const,
      maxCompressedBytes: plain.byteLength,
      maxDecompressedBytes: plain.byteLength,
      nbt: { maxBytes: plain.byteLength },
    }

    expect(await decodeMinecraftNbtFile(await encodeMinecraftNbtFile(original, options), options)).toStrictEqual(original)
    await expect(encodeMinecraftNbtFile(original, { compression: 'none', maxDecompressedBytes: 1 })).rejects.toThrow()
    await expect(encodeMinecraftNbtFile(original, { compression: 'none', maxCompressedBytes: plain.byteLength - 1 })).rejects.toThrow()
    await expect(decodeMinecraftNbtFile(plain, { compression: 'none', maxCompressedBytes: plain.byteLength - 1 })).rejects.toThrow()
    await expect(decodeMinecraftNbtFile(plain, { compression: 'none', maxDecompressedBytes: plain.byteLength - 1 })).rejects.toThrow()
    // @ts-expect-error -- deliberately wrong root type to verify runtime rejection
    await expect(encodeMinecraftNbtFile(null, { compression: 'none' })).rejects.toThrow()
    await expect(
      // @ts-expect-error -- deliberately invalid compression mode to verify runtime rejection
      decodeMinecraftNbtFile(new Uint8Array([1, 2, 3]), { compression: 'invalid' }),
    ).rejects.toThrow()
  })

  it('rejects explicit null NBT file options and compression', async () => {
    // @ts-expect-error -- deliberately invalid options to verify runtime rejection
    await expect(encodeMinecraftNbtFile(original, null)).rejects.toThrow('Minecraft NBT file options must be an object')
    // @ts-expect-error -- deliberately invalid options to verify runtime rejection
    await expect(decodeMinecraftNbtFile(new Uint8Array(), null)).rejects.toThrow('Minecraft NBT file options must be an object')
    // @ts-expect-error -- explicit null compression must not select the gzip default
    await expect(encodeMinecraftNbtFile(original, { compression: null })).rejects.toThrow('Minecraft NBT file compression is invalid')
    // @ts-expect-error -- explicit null compression must not select the gzip default
    await expect(decodeMinecraftNbtFile(new Uint8Array(), { compression: null })).rejects.toThrow('Minecraft NBT file compression is invalid')
  })

  it('maps unreadable NBT file options to typed failures', async () => {
    const unreadableOptions = Object.defineProperty({}, 'compression', {
      get: () => {
        throw new Error('unreadable compression')
      },
    })

    await expect(encodeMinecraftNbtFile(original, unreadableOptions)).rejects.toThrow(
      'Minecraft NBT file options could not be read',
    )
    await expect(decodeMinecraftNbtFile(new Uint8Array(), unreadableOptions)).rejects.toThrow(
      'Minecraft NBT file options could not be read',
    )
  })

  it('maps session lock DataView and byte-copy failures to typed errors', () => {
    const setBigInt64 = vi.spyOn(DataView.prototype, 'setBigInt64')
    try {
      setBigInt64.mockImplementationOnce(() => {
        throw new TypeError('forced set TypeError')
      })
      expect(() => encodeMinecraftSessionLock(1n)).toThrow('forced set TypeError')

      setBigInt64.mockImplementationOnce(() => {
        throw new RangeError('forced set RangeError')
      })
      expect(() => encodeMinecraftSessionLock(1n)).toThrow(
        'Minecraft session.lock RangeError: forced set RangeError',
      )
    } finally {
      setBigInt64.mockRestore()
    }

    const copyFailure = (error: Error): Uint8Array => {
      const bytes = new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES)
      Object.defineProperty(bytes, 'slice', {
        value: () => {
          throw error
        },
      })
      return bytes
    }

    expect(() => decodeMinecraftSessionLock(copyFailure(new TypeError('forced slice TypeError')))).toThrow(
      'forced slice TypeError',
    )
    expect(() =>
      decodeMinecraftSessionLock(copyFailure(new RangeError('forced slice RangeError'))),
    ).toThrow('Minecraft session.lock RangeError: forced slice RangeError')

    const getBigInt64 = vi.spyOn(DataView.prototype, 'getBigInt64')
    try {
      getBigInt64.mockImplementationOnce(() => {
        throw new TypeError('forced get TypeError')
      })
      expect(() => decodeMinecraftSessionLock(new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES))).toThrow(
        'forced get TypeError',
      )

      getBigInt64.mockImplementationOnce(() => {
        throw new RangeError('forced get RangeError')
      })
      expect(() => decodeMinecraftSessionLock(new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES))).toThrow(
        'Minecraft session.lock RangeError: forced get RangeError',
      )
    } finally {
      getBigInt64.mockRestore()
    }
  })

  it('encodes and decodes signed big-endian session locks', () => {
    expect(MINECRAFT_SESSION_LOCK_BYTES).toBe(8)
    const values = [0n, -1n, -(1n << 63n), (1n << 63n) - 1n]

    for (const value of values) {
      const encoded = encodeMinecraftSessionLock(value)
      expect(encoded.byteLength).toBe(MINECRAFT_SESSION_LOCK_BYTES)
      expect(decodeMinecraftSessionLock(encoded)).toBe(value)
    }

    expect(encodeMinecraftSessionLock(0n)).toStrictEqual(new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES))
    expect(decodeMinecraftSessionLock(Uint8Array.from({ length: MINECRAFT_SESSION_LOCK_BYTES }, () => 0xff))).toBe(-1n)

    const backing = new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES + 2)
    backing.set(encodeMinecraftSessionLock(42n), 1)
    expect(decodeMinecraftSessionLock(backing.subarray(1, 9))).toBe(42n)
  })

  it('rejects invalid session lock values and byte lengths', () => {
    // @ts-expect-error -- deliberately wrong type to verify runtime rejection
    expect(() => encodeMinecraftSessionLock(1)).toThrow()
    expect(() => encodeMinecraftSessionLock(-(1n << 63n) - 1n)).toThrow()
    expect(() => encodeMinecraftSessionLock(1n << 63n)).toThrow()
    // @ts-expect-error -- deliberately wrong type to verify runtime rejection
    expect(() => decodeMinecraftSessionLock(null)).toThrow()
    expect(() => decodeMinecraftSessionLock(new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES - 1))).toThrow()
    expect(() => decodeMinecraftSessionLock(new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES + 1))).toThrow()
  })
})
