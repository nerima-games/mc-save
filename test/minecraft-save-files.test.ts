/* oxlint-disable no-bitwise -- tests construct signed 64-bit session-lock boundaries. */
import { describe, expect, it } from 'vitest'
import {
  MINECRAFT_NBT_FILE_COMPRESSION,
  MINECRAFT_SESSION_LOCK_BYTES,
  decodeMinecraftNbtFile,
  decodeMinecraftSessionLock,
  encodeMinecraftNbtFile,
  encodeMinecraftSessionLock,
} from '../src/domain/minecraft-save-files.js'
import { nbtByte, nbtCompound, nbtDocument, nbtString } from '../src/domain/minecraft-nbt.js'

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
    await expect(encodeMinecraftNbtFile(null as never, { compression: 'none' })).rejects.toThrow()
    await expect(decodeMinecraftNbtFile(new Uint8Array([1, 2, 3]), { compression: 'invalid' as never })).rejects.toThrow()
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
    expect(() => encodeMinecraftSessionLock(1 as never)).toThrow()
    expect(() => encodeMinecraftSessionLock(-(1n << 63n) - 1n)).toThrow()
    expect(() => encodeMinecraftSessionLock(1n << 63n)).toThrow()
    expect(() => decodeMinecraftSessionLock(null as never)).toThrow()
    expect(() => decodeMinecraftSessionLock(new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES - 1))).toThrow()
    expect(() => decodeMinecraftSessionLock(new Uint8Array(MINECRAFT_SESSION_LOCK_BYTES + 1))).toThrow()
  })
})
