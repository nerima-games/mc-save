/* oxlint-disable no-bitwise -- test fixtures construct exact big-endian NBT bytes. */

import { Result } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NBT_CODEC_OPTIONS,
  NBT_TAG_IDS,
  NbtFormatError,
  decodeNbt as decodeNbtResult,
  encodeNbt as encodeNbtResult,
  nbtByte as nbtByteResult,
  nbtByteArray as nbtByteArrayResult,
  nbtCompound as nbtCompoundResult,
  nbtDocument as nbtDocumentResult,
  nbtDouble as nbtDoubleResult,
  nbtEnd,
  nbtFloat as nbtFloatResult,
  nbtInt as nbtIntResult,
  nbtIntArray as nbtIntArrayResult,
  nbtList as nbtListResult,
  nbtLong as nbtLongResult,
  nbtLongArray as nbtLongArrayResult,
  nbtShort as nbtShortResult,
  nbtString as nbtStringResult,
  isMinecraftNbtDocument,
} from '../src/domain/minecraft-nbt.js'
import { assertLong, tagId } from '../src/domain/minecraft-nbt-codec-support.js'
import { resolveNbtCodecOptions, type ResolvedNbtCodecOptions } from '../src/domain/minecraft-nbt-codec-options.js'
import { decodeNbtBytes } from '../src/domain/minecraft-nbt-decoding.js'
import { encodeNbtDocument } from '../src/domain/minecraft-nbt-encoding.js'
import { isMinecraftNbtTag } from '../src/domain/minecraft-nbt-validation.js'

const unwrapResult = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const decodeNbt = (...args: Parameters<typeof decodeNbtResult>) => unwrapResult(decodeNbtResult(...args))
const encodeNbt = (...args: Parameters<typeof encodeNbtResult>) => unwrapResult(encodeNbtResult(...args))
const nbtByte = (...args: Parameters<typeof nbtByteResult>) => unwrapResult(nbtByteResult(...args))
const nbtByteArray = (...args: Parameters<typeof nbtByteArrayResult>) => unwrapResult(nbtByteArrayResult(...args))
const nbtCompound = (...args: Parameters<typeof nbtCompoundResult>) => unwrapResult(nbtCompoundResult(...args))
const nbtDocument = (...args: Parameters<typeof nbtDocumentResult>) => unwrapResult(nbtDocumentResult(...args))
const nbtDouble = (...args: Parameters<typeof nbtDoubleResult>) => unwrapResult(nbtDoubleResult(...args))
const nbtFloat = (...args: Parameters<typeof nbtFloatResult>) => unwrapResult(nbtFloatResult(...args))
const nbtInt = (...args: Parameters<typeof nbtIntResult>) => unwrapResult(nbtIntResult(...args))
const nbtIntArray = (...args: Parameters<typeof nbtIntArrayResult>) => unwrapResult(nbtIntArrayResult(...args))
const nbtList = (...args: Parameters<typeof nbtListResult>) => unwrapResult(nbtListResult(...args))
const nbtLong = (...args: Parameters<typeof nbtLongResult>) => unwrapResult(nbtLongResult(...args))
const nbtLongArray = (...args: Parameters<typeof nbtLongArrayResult>) => unwrapResult(nbtLongArrayResult(...args))
const nbtShort = (...args: Parameters<typeof nbtShortResult>) => unwrapResult(nbtShortResult(...args))
const nbtString = (...args: Parameters<typeof nbtStringResult>) => unwrapResult(nbtStringResult(...args))

const expectNbtError = (operation: () => unknown): void => {
  expect(operation).toThrowError(NbtFormatError)
}

/**
 * Passes `value` through untyped, for constructing a deliberately
 * runtime-invalid argument to a statically-typed factory in a negative test.
 * The `any` return (not `unknown`) is what lets the result flow into any
 * parameter type with no type assertion at the call site.
 */
const asUnchecked = (value: unknown): any => value

const invalidStringIterator = (): StringIterator<string> => {
  let done = false
  const iterator: StringIterator<string> = {
    next: (): IteratorResult<string> => {
      if (done) return { done: true, value: undefined }
      done = true
      return { done: false, value: '' }
    },
    [Symbol.iterator]: () => iterator,
    [Symbol.dispose]: (): void => undefined,
  }
  return iterator
}

const rootWithPayload = (payload: ReadonlyArray<number>): Uint8Array =>
  Uint8Array.from([NBT_TAG_IDS.compound, 0, 0, ...payload])

const rootWithNameBytes = (name: ReadonlyArray<number>, payload: ReadonlyArray<number> = [NBT_TAG_IDS.end]): Uint8Array =>
  Uint8Array.from([NBT_TAG_IDS.compound, (name.length >> 8) & 0xff, name.length & 0xff, ...name, ...payload])

const namedTag = (tag: number, name: ReadonlyArray<number>, payload: ReadonlyArray<number>): Uint8Array =>
  rootWithPayload([tag, (name.length >> 8) & 0xff, name.length & 0xff, ...name, ...payload, NBT_TAG_IDS.end])

describe('Minecraft NBT factories and codec', () => {
  it('round-trips every official tag type through big-endian NBT', () => {
    const original = nbtDocument(
      'root\0é漢😀',
      nbtCompound([
        ['byte', nbtByte(-12)],
        ['short', nbtShort(-1234)],
        ['int', nbtInt(0x10203040)],
        ['long', nbtLong(-9007199254740991n)],
        ['float', nbtFloat(1.5)],
        ['double', nbtDouble(-2.25)],
        ['byte-array', nbtByteArray(new Uint8Array([0, 1, 255]))],
        ['string', nbtString('text\0é漢😀')],
        ['byte-list', nbtList('byte', [nbtByte(-1), nbtByte(2)])],
        ['empty-list', nbtList('end', [])],
        ['nested', nbtCompound([['value', nbtString('nested')]])],
        ['int-array', nbtIntArray([-1, 0, 1])],
        ['long-array', nbtLongArray([-1n, 0n, 1n])],
      ]),
    )

    expect(decodeNbt(encodeNbt(original))).toStrictEqual(original)
  })

  it('writes the root, name, payload, and terminator in the official order', () => {
    const encoded = encodeNbt(nbtDocument('', nbtCompound([['v', nbtInt(0x01020304)]])))

    expect([...encoded]).toStrictEqual([10, 0, 0, 3, 0, 1, 0x76, 1, 2, 3, 4, 0])
    expect(decodeNbt(encoded)).toStrictEqual(nbtDocument('', nbtCompound([['v', nbtInt(0x01020304)]])))
  })

  it('copies mutable byte arrays and list, compound, and numeric-array inputs', () => {
    const bytes = new Uint8Array([1, 2])
    const listValues = [nbtByte(1)]
    const entries: Array<readonly [string, ReturnType<typeof nbtByte>]> = [['x', nbtByte(1)]]
    const ints = [1, 2]
    const longs = [1n, 2n]
    const byteValue = nbtByteArray(bytes)
    const listValue = nbtList('byte', listValues)
    const compoundValue = nbtCompound(entries)
    const intValue = nbtIntArray(ints)
    const longValue = nbtLongArray(longs)

    bytes[0] = 9
    listValues[0] = nbtByte(9)
    entries[0] = ['x', nbtByte(9)]
    ints[0] = 9
    longs[0] = 9n

    expect(byteValue.value).toStrictEqual(new Uint8Array([1, 2]))
    expect(listValue.values).toStrictEqual([nbtByte(1)])
    expect(compoundValue.entries).toStrictEqual([['x', nbtByte(1)]])
    expect(intValue.value).toStrictEqual([1, 2])
    expect(longValue.value).toStrictEqual([1n, 2n])
  })

  it('rejects unreadable NBT tag discriminants without throwing', () => {
    expect(isMinecraftNbtTag(null)).toBe(false)
    const unreadableType = Object.defineProperty({}, 'type', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable tag type')
      },
    })
    expect(isMinecraftNbtTag(unreadableType)).toBe(false)
    expect(isMinecraftNbtTag(nbtEnd())).toBe(true)
  })

  it('maps invalid modified UTF-8 from tag and document constructors', () => {
    const iteratorSpy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(invalidStringIterator)
    try {
      expectNbtError(() => nbtString('invalid'))
      expectNbtError(() => nbtCompound([['invalid', nbtByte(1)]]))
      expectNbtError(() => nbtDocument('invalid', nbtCompound([])))
    } finally {
      iteratorSpy.mockRestore()
    }
  })

  it('maps invalid modified UTF-8 from the NBT writer after document validation', () => {
    const resolved = unwrapResult(resolveNbtCodecOptions(DEFAULT_NBT_CODEC_OPTIONS))
    let restoreIterator: () => void = () => undefined
    const options: ResolvedNbtCodecOptions = {
      ...resolved,
      get maxBytes() {
        const iteratorSpy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(invalidStringIterator)
        restoreIterator = () => iteratorSpy.mockRestore()
        return resolved.maxBytes
      },
    }
    const document = nbtDocument('', nbtCompound([]))
    const encoded = (() => {
      try {
        return encodeNbtDocument(document, options)
      } finally {
        restoreIterator()
      }
    })()
    expect(Result.isFailure(encoded)).toBe(true)
    expect(() => Result.getOrThrow(encoded)).toThrowError(NbtFormatError)
  })

  it('validates factory ranges, tag relationships, names, and root shape', () => {
    expect(() => nbtByte(-129)).toThrowError(NbtFormatError)
    expect(() => nbtByte(128)).toThrowError(NbtFormatError)
    expect(() => nbtShort(-32769)).toThrowError(NbtFormatError)
    expect(() => nbtShort(32768)).toThrowError(NbtFormatError)
    expect(() => nbtInt(-2147483649)).toThrowError(NbtFormatError)
    expect(() => nbtInt(2147483648)).toThrowError(NbtFormatError)
    expect(() => nbtLong(asUnchecked(1))).toThrowError(NbtFormatError)
    expect(() => nbtLong(-9223372036854775809n)).toThrowError(NbtFormatError)
    expect(() => nbtLong(9223372036854775808n)).toThrowError(NbtFormatError)
    // @ts-expect-error -- unknown tag ids are rejected at runtime
    expect(Result.isFailure(tagId('unknown'))).toBe(true)
    expect(Result.isFailure(assertLong(0x8000000000000000n))).toBe(true)
    expect(() => nbtFloat(asUnchecked('1'))).toThrowError(NbtFormatError)
    expect(() => nbtDouble(asUnchecked('1'))).toThrowError(NbtFormatError)
    expect(() => nbtByteArray(asUnchecked([1]))).toThrowError(NbtFormatError)
    const unreadableByteArray = new Uint8Array([1])
    Object.defineProperty(unreadableByteArray, 'slice', { value: () => { throw new Error('byte array copy failed') } })
    expect(() => nbtByteArray(unreadableByteArray)).toThrowError(NbtFormatError)
    expect(() => nbtString(asUnchecked(1))).toThrowError(NbtFormatError)
    expect(() => nbtString('a'.repeat(65536))).toThrowError(NbtFormatError)
    expect(() => nbtList(asUnchecked(null), [])).toThrowError(NbtFormatError)
    expect(() => nbtList(asUnchecked('unknown'), [])).toThrowError(NbtFormatError)
    expect(() => nbtList('byte', asUnchecked(null))).toThrowError(NbtFormatError)
    expect(() => nbtList('byte', [asUnchecked(null)])).toThrowError(NbtFormatError)
    expect(() => nbtList('end', [nbtEnd()])).toThrowError(NbtFormatError)
    expect(() => nbtList('byte', [nbtEnd()])).toThrowError(NbtFormatError)
    expect(() => nbtList('byte', [nbtString('wrong')])).toThrowError(NbtFormatError)
    expect(() => nbtCompound([['duplicate', nbtByte(1)], ['duplicate', nbtByte(2)]])).toThrowError(NbtFormatError)
    expect(() => nbtCompound(asUnchecked([[1, nbtByte(1)]]))).toThrowError(NbtFormatError)
    expect(() => nbtCompound(asUnchecked([['missing value']]))).toThrowError(NbtFormatError)
    expect(() => nbtCompound(asUnchecked(null))).toThrowError(NbtFormatError)
    expect(() => nbtCompound([asUnchecked(null)])).toThrowError(NbtFormatError)
    expect(() => nbtCompound([['value', asUnchecked(null)]])).toThrowError(NbtFormatError)
    expect(() => nbtCompound([['unknown', asUnchecked({ type: 'unknown' })]])).toThrowError(NbtFormatError)
    expect(() => nbtCompound([['end', nbtEnd()]])).toThrowError(NbtFormatError)
    expect(() => nbtCompound([['a'.repeat(65536), nbtByte(1)]])).toThrowError(NbtFormatError)
    expect(() => nbtIntArray([1.5])).toThrowError(NbtFormatError)
    expect(() => nbtIntArray(asUnchecked([1, 'bad']))).toThrowError(NbtFormatError)
    expect(() => nbtIntArray(asUnchecked(null))).toThrowError(NbtFormatError)
    expect(() => nbtLongArray([asUnchecked(1)])).toThrowError(NbtFormatError)
    expect(() => nbtLongArray(asUnchecked(null))).toThrowError(NbtFormatError)
    expect(() => nbtDocument(asUnchecked(1), nbtCompound([]))).toThrowError(NbtFormatError)
    expect(() => nbtDocument('a'.repeat(65536), nbtCompound([]))).toThrowError(NbtFormatError)
    expect(() => nbtDocument('', asUnchecked(nbtByte(1)))).toThrowError(NbtFormatError)
    expect(() => nbtDocument('', asUnchecked(null))).toThrowError(NbtFormatError)
  })

  it('validates the complete NBT document shape before persistence', () => {
    const valid = nbtDocument(
      'root',
      nbtCompound([
        ['byte', nbtByte(-1)],
        ['short', nbtShort(-2)],
        ['int', nbtInt(-3)],
        ['long', nbtLong(-4n)],
        ['float', nbtFloat(Number.NaN)],
        ['double', nbtDouble(Number.POSITIVE_INFINITY)],
        ['byteArray', nbtByteArray(new Uint8Array([1, 2]))],
        ['string', nbtString('value')],
        ['list', nbtList('byte', [nbtByte(1)])],
        ['emptyList', nbtList('end', [])],
        ['compound', nbtCompound([['nested', nbtString('value')]])],
        ['intArray', nbtIntArray([1, 2])],
        ['longArray', nbtLongArray([1n, 2n])],
      ]),
    )
    expect(isMinecraftNbtDocument(valid)).toBe(true)

    const invalid: unknown[] = [
      null,
      { name: '', root: valid.root, extra: true },
      { name: 1, root: valid.root },
      { name: '', root: nbtByte(1) },
      { name: '', root: { type: 'unknown', entries: [] } },
      { name: '', root: { type: 'compound', entries: [['duplicate', nbtByte(1)], ['duplicate', nbtByte(2)]] } },
      { name: '', root: { type: 'compound', entries: [['bad-name', nbtEnd()]] } },
      { name: '', root: { type: 'list', elementType: 'byte', values: [nbtByte(1)] } },
      { name: '', root: { type: 'list', elementType: 'end', values: [nbtByte(1)] } },
      { name: '', root: { type: 'byte', value: 128 } },
      { name: '', root: { type: 'long', value: 1 } },
      { name: '', root: { type: 'byteArray', value: [1] } },
      { name: '', root: { type: 'string', value: 'a'.repeat(65536) } },
      { name: '', root: { type: 'intArray', value: [1.5] } },
      { name: '', root: { type: 'longArray', value: [1] } },
      { name: '', root: { type: 'compound', entries: [['pair', [nbtByte(1), nbtByte(2), nbtByte(3)]]] } },
    ]
    for (const value of invalid) expect(isMinecraftNbtDocument(value)).toBe(false)

    const sparseValues = new Array(1)
    expect(
      isMinecraftNbtDocument({
        name: '',
        root: { type: 'compound', entries: [['sparse', { type: 'list', elementType: 'byte', values: sparseValues }]] },
      }),
    ).toBe(false)

    const customBytes = new Uint8Array([1])
    Object.defineProperty(customBytes, 'extra', { enumerable: true, value: true })
    expect(
      isMinecraftNbtDocument({
        name: '',
        root: { type: 'compound', entries: [['bytes', { type: 'byteArray', value: customBytes }]] },
      }),
    ).toBe(false)

    const cyclic: { type: 'compound'; entries: unknown[] } = { type: 'compound', entries: [] }
    cyclic.entries.push(['cycle', cyclic])
    expect(isMinecraftNbtDocument({ name: '', root: cyclic })).toBe(false)

    const throwingType = Object.defineProperty({ value: 1 }, 'type', {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error('unstable')
      },
    })
    expect(isMinecraftNbtDocument({ name: '', root: { type: 'compound', entries: [['throwing', throwingType]] } })).toBe(false)
  })

  it('formats NBT errors with and without byte offsets', () => {
    expect(new NbtFormatError({ reason: 'header' }).message).toBe('NBT data is invalid: header')
    expect(new NbtFormatError({ reason: 'payload', offset: 4 }).message).toBe(
      'NBT data is invalid at byte offset 4: payload',
    )
  })

  it('decodes a SharedArrayBuffer-backed input after copying it', () => {
    const encoded = encodeNbt(nbtDocument('', nbtCompound([])))
    const shared = new Uint8Array(new SharedArrayBuffer(encoded.byteLength))
    shared.set(encoded)

    expect(Result.isFailure(decodeNbtResult(shared))).toBe(false)
    expect(decodeNbt(shared)).toStrictEqual(nbtDocument('', nbtCompound([])))
  })

  it('rejects malformed root structure, lengths, ids, duplicates, and trailing bytes', () => {
    expectNbtError(() => decodeNbt(new Uint8Array()))
    expectNbtError(() => decodeNbt(new Uint8Array([NBT_TAG_IDS.byte])))
    expectNbtError(() => decodeNbt(new Uint8Array([NBT_TAG_IDS.compound])))
    expectNbtError(() => decodeNbt(rootWithPayload([NBT_TAG_IDS.byte])))
    expectNbtError(() => decodeNbt(asUnchecked(null)))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.end, [101], [])))
    expectNbtError(() => decodeNbt(rootWithPayload([13])))
    expectNbtError(() => decodeNbt(Uint8Array.from([...rootWithPayload([NBT_TAG_IDS.end]), 1])))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.byteArray, [98], [0xff, 0xff, 0xff, 0xff])))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.intArray, [105], [0xff, 0xff, 0xff, 0xff])))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.longArray, [108], [0xff, 0xff, 0xff, 0xff])))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.list, [108], [13, 0, 0, 0, 0])))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.list, [108], [NBT_TAG_IDS.end, 0, 0, 0, 1])))
    expectNbtError(() => decodeNbt(rootWithPayload([NBT_TAG_IDS.byte, 0, 1, 97, 1, NBT_TAG_IDS.byte, 0, 1, 97, 2, 0])))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.byte, [97], [])))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.byteArray, [97], [0, 0, 0, 1])))
    expectNbtError(() => decodeNbt(namedTag(NBT_TAG_IDS.byteArray, [97], [0, 0, 0, 0, 1])))
  })

  it('rejects malformed modified UTF-8 at the decode boundary', () => {
    const malformedNames = [
      [0x00],
      [0x80],
      [0xc2, 0x41],
      [0xc1, 0x81],
      [0xc2],
      [0xe0, 0x80, 0x80],
      [0xe2, 0x82],
      [0xf0, 0x80, 0x80, 0x80],
    ]

    for (const name of malformedNames) {
      expectNbtError(() => decodeNbt(rootWithNameBytes(name)))
    }
  })

  it('rejects invalid codec limits and enforces them during encoding and decoding', () => {
    const nested = nbtDocument('', nbtCompound([['nested', nbtCompound([['value', nbtString('value')]])]]))
    const encodedNested = encodeNbt(nested)
    const stringDocument = nbtDocument('', nbtCompound([['value', nbtString('long')]]))
    const encodedString = encodeNbt(stringDocument)

    expect(DEFAULT_NBT_CODEC_OPTIONS.maxBytes).toBe(64 * 1024 * 1024)
    expect(() => encodeNbt(nested, { maxBytes: 0 })).toThrowError(NbtFormatError)
    expect(() => encodeNbt(nested, { maxBytes: 3 })).toThrowError(NbtFormatError)
    expect(() => encodeNbt(nested, { maxDepth: 0 })).toThrowError(NbtFormatError)
    expect(() => encodeNbt(nested, { maxElements: -1 })).toThrowError(NbtFormatError)
    expect(() => encodeNbt(stringDocument, { maxStringBytes: -1 })).toThrowError(NbtFormatError)
    expect(() => encodeNbt(stringDocument, { maxStringBytes: 1 })).toThrowError(NbtFormatError)
    expect(() => encodeNbt(nested, { maxDepth: 1 })).toThrowError(NbtFormatError)
    expect(() => encodeNbt(nested, { maxElements: 0 })).toThrowError(NbtFormatError)
    expect(() => decodeNbt(encodedNested, { maxDepth: 1 })).toThrowError(NbtFormatError)
    expect(() => decodeNbt(encodedNested, { maxElements: 0 })).toThrowError(NbtFormatError)
    expect(() => decodeNbt(encodedString, { maxStringBytes: 1 })).toThrowError(NbtFormatError)
    expect(() => decodeNbt(encodedString, { maxBytes: encodedString.byteLength - 1 })).toThrowError(NbtFormatError)
    expect(() => decodeNbt(encodedString, { maxBytes: 0 })).toThrowError(NbtFormatError)
    expect(() => decodeNbt(encodedString, { maxDepth: 0 })).toThrowError(NbtFormatError)
    expect(() => decodeNbt(encodedString, { maxElements: -1 })).toThrowError(NbtFormatError)
    expect(() => decodeNbt(encodedString, { maxStringBytes: 65536 })).toThrowError(NbtFormatError)
  })

  it('rejects malformed runtime values before writing them', () => {
    expectNbtError(() => encodeNbt(asUnchecked(null)))
    expectNbtError(() => encodeNbt(asUnchecked({ name: 1, root: nbtCompound([]) })))
    expectNbtError(() => encodeNbt(asUnchecked({ name: '', root: null })))
    expectNbtError(() => encodeNbt(asUnchecked({ name: '', root: nbtByte(1) })))
    expectNbtError(() =>
      encodeNbt(asUnchecked({ name: '', root: { type: 'compound', entries: [['end', { type: 'end' }]] } })),
    )
    let typeReads = 0
    const unstableType = {
      get type(): string {
        typeReads += 1
        return typeReads === 1 ? 'byte' : 'unknown'
      },
      value: 1,
    }
    const encodedSnapshot = encodeNbt(
      asUnchecked({ name: '', root: { type: 'compound', entries: [['unstable', unstableType]] } }),
    )
    expect(encodedSnapshot.byteLength).toBeGreaterThan(0)
    expect(typeReads).toBe(1)
    expectNbtError(() =>
      encodeNbt(asUnchecked({ name: '', root: { type: 'compound', entries: [['unknown', { type: 'unknown' }]] } })),
    )
    expectNbtError(() =>
      encodeNbt(asUnchecked({ name: '', root: { type: 'compound', entries: [['long', { type: 'long', value: 'bad' }]] } })),
    )
    expectNbtError(() =>
      encodeNbt(asUnchecked({ name: '', root: { type: 'compound', entries: [['float', { type: 'float', value: 'bad' }]] } })),
    )
    expectNbtError(() =>
      encodeNbt(asUnchecked({ name: '', root: { type: 'compound', entries: [['double', { type: 'double', value: 'bad' }]] } })),
    )
    expectNbtError(() =>
      encodeNbt(asUnchecked({ name: '', root: { type: 'compound', entries: [['string', { type: 'string', value: 1 }]] } })),
    )
    expectNbtError(() =>
      encodeNbt(asUnchecked({ name: '', root: { type: 'compound', entries: [['bytes', { type: 'byteArray', value: [1] }]] } })),
    )
    expectNbtError(() =>
      encodeNbt(
        asUnchecked({
          name: '',
          root: { type: 'compound', entries: [['list', { type: 'list', elementType: 'end', values: [nbtByte(1)] }]] },
        }),
      ),
    )
    expectNbtError(() =>
      encodeNbt(
        asUnchecked({
          name: '',
          root: { type: 'compound', entries: [['list', { type: 'list', elementType: 'byte', values: [nbtString('wrong')] }]] },
        }),
      ),
    )
    expectNbtError(() =>
      encodeNbt(
        asUnchecked({
          name: '',
          root: {
            type: 'compound',
            entries: [
              ['duplicate', nbtByte(1)],
              ['duplicate', nbtByte(2)],
            ],
          },
        }),
      ),
    )
  })

  it('expands its bounded writer for payloads larger than the initial buffer', () => {
    const original = nbtDocument('', nbtCompound([['large', nbtString('x'.repeat(2048))]]))

    expect(decodeNbt(encodeNbt(original))).toStrictEqual(original)
  })

  it('maps unreadable factory arrays and tag getters to NbtFormatError', () => {
    const unreadableEntries = new Proxy([], {
      get: (target, key, receiver) => {
        if (key === 'length') throw new Error('array length failed')
        return Reflect.get(target, key, receiver)
      },
    })
    expectNbtError(() => nbtCompound(unreadableEntries))
    expectNbtError(() => nbtList('byte', unreadableEntries))

    const unreadableTag = new Proxy({ type: 'byte', value: 1 }, {
      get: (target, key, receiver) => {
        if (key === 'type') throw new Error('tag type failed')
        return Reflect.get(target, key, receiver)
      },
    })
    expectNbtError(() => nbtDocument('', asUnchecked(unreadableTag)))
    expectNbtError(() => nbtCompound([['value', asUnchecked(unreadableTag)]]))
  })


  it('maps NBT input and output byte-copy failures to format errors', () => {
    const originalSlice = Uint8Array.prototype.slice
    const byteArrayDocument = nbtDocument('', nbtCompound([['bytes', nbtByteArray(new Uint8Array([0x7f]))]]))
    const byteCopySpy = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (
      this: Uint8Array,
      start?: number,
      end?: number,
    ) {
      if (this.byteLength === 1 && this[0] === 0x7f) throw new Error('byte array copy failed')
      return originalSlice.call(this, start, end)
    })
    try {
      expectNbtError(() => encodeNbt(byteArrayDocument))
    } finally {
      byteCopySpy.mockRestore()
    }

    const outputCopySpy = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (
      this: Uint8Array,
      start?: number,
      end?: number,
    ) {
      if (this.byteLength === 1024) throw new Error('encoded output copy failed')
      return originalSlice.call(this, start, end)
    })
    try {
      expectNbtError(() => encodeNbt(nbtDocument('', nbtCompound([]))))
    } finally {
      outputCopySpy.mockRestore()
    }

    const encodedEmpty = new Uint8Array(encodeNbt(nbtDocument('', nbtCompound([]))))
    const readCopySpy = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (
      this: Uint8Array,
      start?: number,
      end?: number,
    ) {
      if (start !== undefined) throw new Error('decoded byte sequence copy failed')
      return originalSlice.call(this, start, end)
    })
    try {
      expectNbtError(() => decodeNbt(encodedEmpty))
    } finally {
      readCopySpy.mockRestore()
    }

    const options = unwrapResult(resolveNbtCodecOptions(undefined))
    const outOfBoundsView = new Uint8Array([NBT_TAG_IDS.compound])
    Object.defineProperty(outOfBoundsView, 'byteLength', { value: 2 })
    expect(Result.isFailure(decodeNbtBytes(outOfBoundsView, options))).toBe(true)
  })

  it('maps unreadable codec options, uncopyable snapshots, and shared-buffer input to NbtFormatError', () => {
    const document = nbtDocument('', nbtCompound([]))
    const unreadableOptions = new Proxy({}, { get: () => { throw new Error('unreadable NBT options') } })
    expectNbtError(() => encodeNbt(document, unreadableOptions))
    expectNbtError(() => decodeNbt(new Uint8Array([10, 0, 0, 0]), unreadableOptions))
    expectNbtError(() => encodeNbt(document, asUnchecked(null)))
    expectNbtError(() => decodeNbt(new Uint8Array([10, 0, 0, 0]), asUnchecked(null)))

    const uncloneableDocument = new Proxy(document, {})
    expectNbtError(() => encodeNbt(asUnchecked(uncloneableDocument)))

    const uncopiableBytes = new Uint8Array(encodeNbt(document))
    Object.defineProperty(uncopiableBytes, 'slice', {
      value: () => {
        throw new Error('input copy failed')
      },
    })
    expectNbtError(() => decodeNbt(uncopiableBytes))

    const sharedBytes = new Uint8Array(new SharedArrayBuffer(1))
    expectNbtError(() => decodeNbt(sharedBytes))

    const validBytes = new Uint8Array(encodeNbt(document))
    const sharedSnapshot = new Uint8Array(new SharedArrayBuffer(validBytes.byteLength))
    sharedSnapshot.set(validBytes)
    Object.defineProperty(validBytes, 'slice', { value: () => sharedSnapshot })
    expectNbtError(() => decodeNbt(validBytes))
  })

})
