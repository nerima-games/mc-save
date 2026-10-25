import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  NbtFormatError,
  nbtByte as nbtByteResult,
  nbtCompound as nbtCompoundResult,
  nbtDocument as nbtDocumentResult,
  nbtString as nbtStringResult,
} from '../src/domain/minecraft-nbt.js'
import {
  MinecraftCompressionError,
  type MinecraftCompression,
} from '../src/domain/minecraft-compression.js'
import { decodeCompressedNbt as decodeCompressedNbtEffect, encodeCompressedNbt as encodeCompressedNbtEffect } from '../src/domain/minecraft-nbt-compression.js'

const unwrapResult = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const nbtByte = (...args: Parameters<typeof nbtByteResult>) => unwrapResult(nbtByteResult(...args))
const nbtCompound = (...args: Parameters<typeof nbtCompoundResult>) => unwrapResult(nbtCompoundResult(...args))
const nbtDocument = (...args: Parameters<typeof nbtDocumentResult>) => unwrapResult(nbtDocumentResult(...args))
const nbtString = (...args: Parameters<typeof nbtStringResult>) => unwrapResult(nbtStringResult(...args))
const decodeCompressedNbt = (...args: Parameters<typeof decodeCompressedNbtEffect>) => Effect.runPromise(decodeCompressedNbtEffect(...args))
const encodeCompressedNbt = (...args: Parameters<typeof encodeCompressedNbtEffect>) => Effect.runPromise(encodeCompressedNbtEffect(...args))

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

// Widens a value's static type to `T` with NO runtime transformation and no type assertion:
// `Record<string, any>` indexing is `any` by construction, assignable anywhere with zero compiler
// complaint. Used to hand a type-invalid input to a strictly-typed function, so the test proves the
// function's own runtime check — not the type checker — rejects it.
const widen = <T,>(value: unknown): T => {
  const bag: Record<string, any> = {}
  bag['value'] = value
  return bag['value']
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
    await expectCompressionError(decodeCompressedNbt(widen(null), 'none'))
    await expectCompressionError(encodeCompressedNbt(original, widen<MinecraftCompression>('invalid')))
    await expectNbtError(decodeCompressedNbt(new Uint8Array([NBT_COMPOUND_ID]), 'none'))
    await expectNbtError(encodeCompressedNbt(widen(null), 'none'))
  })

  it('maps unreadable compression options to NBT boundary errors', async () => {
    const unreadableOptions = new Proxy({}, { get: () => { throw new Error('unreadable compressed NBT options') } })
    await expectNbtError(encodeCompressedNbt(original, 'none', unreadableOptions))
    await expectNbtError(decodeCompressedNbt(new Uint8Array([10, 0, 0]), 'none', unreadableOptions))
    await expectNbtError(encodeCompressedNbt(original, 'none', widen(null)))
    await expectNbtError(decodeCompressedNbt(new Uint8Array([10, 0, 0]), 'none', widen(null)))
  })

})

const NBT_COMPOUND_ID = 10
