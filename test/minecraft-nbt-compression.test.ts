import { describe, expect, it } from 'vitest'
import {
  NbtFormatError,
  nbtByte,
  nbtCompound,
  nbtDocument,
  nbtString,
} from '../src/domain/minecraft-nbt.js'
import {
  MinecraftCompressionError,
  type MinecraftCompression,
} from '../src/domain/minecraft-compression.js'
import { decodeCompressedNbt, encodeCompressedNbt } from '../src/domain/minecraft-nbt-compression.js'

const original = nbtDocument(
  'root\0é漢😀',
  nbtCompound([
    ['byte', nbtByte(-12)],
    ['string', nbtString('text\0é漢😀')],
    ['nested', nbtCompound([['value', nbtString('nested')]])],
  ]),
)

const expectNbtError = async (operation: Promise<unknown>): Promise<void> => {
  await expect(operation).rejects.toThrowError(NbtFormatError)
}

const expectCompressionError = async (operation: Promise<unknown>): Promise<void> => {
  await expect(operation).rejects.toThrowError(MinecraftCompressionError)
}

describe('Minecraft compressed NBT codec', () => {
  it.each(['gzip', 'zlib', 'none', 'lz4'] as const)('round-trips NBT through %s', async (compression) => {
    const encoded = await encodeCompressedNbt(original, compression)

    expect(encoded.byteLength).toBeGreaterThan(0)
    expect(await decodeCompressedNbt(encoded, compression)).toStrictEqual(original)
  })

  it('passes compression and NBT limits to both directions', async () => {
    const plain = await encodeCompressedNbt(original, 'none')
    const options = { maxCompressedBytes: plain.byteLength, maxDecompressedBytes: plain.byteLength, nbt: { maxBytes: plain.byteLength } }

    expect(await decodeCompressedNbt(await encodeCompressedNbt(original, 'none', options), 'none', options)).toStrictEqual(original)
    await expectCompressionError(encodeCompressedNbt(original, 'none', { maxDecompressedBytes: 1 }))
    await expectCompressionError(encodeCompressedNbt(original, 'none', { maxCompressedBytes: plain.byteLength - 1 }))
    await expectCompressionError(decodeCompressedNbt(plain, 'none', { maxCompressedBytes: plain.byteLength - 1 }))
    await expectCompressionError(decodeCompressedNbt(plain, 'none', { maxDecompressedBytes: plain.byteLength - 1 }))
    await expectNbtError(encodeCompressedNbt(original, 'none', { nbt: { maxBytes: 1 } }))
    await expectNbtError(decodeCompressedNbt(plain, 'none', { nbt: { maxBytes: 1 } }))
  })

  it('supports options where only one compression limit is present', async () => {
    const encoded = await encodeCompressedNbt(original, 'none', { maxDecompressedBytes: 4096 })
    expect(await decodeCompressedNbt(encoded, 'none', { maxCompressedBytes: encoded.byteLength })).toStrictEqual(original)
  })

  it('preserves compression and NBT errors at their boundaries', async () => {
    await expectCompressionError(decodeCompressedNbt(new Uint8Array([1, 2, 3]), 'gzip'))
    await expectCompressionError(decodeCompressedNbt(null as never, 'none'))
    await expectCompressionError(encodeCompressedNbt(original, 'invalid' as MinecraftCompression))
    await expectNbtError(decodeCompressedNbt(new Uint8Array([NBT_COMPOUND_ID]), 'none'))
    await expectNbtError(encodeCompressedNbt(null as never, 'none'))
  })
})

const NBT_COMPOUND_ID = 10
