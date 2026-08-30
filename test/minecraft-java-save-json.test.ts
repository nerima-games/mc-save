import { describe, expect, it, vi } from 'vitest'
import {
  decodeMinecraftJson,
  encodeMinecraftJson,
  isMinecraftJsonValue,
  MinecraftJsonError,
} from '../src/domain/minecraft-java-save-json.js'

const expectJsonError = (operation: () => unknown): void => {
  expect(operation).toThrowError(MinecraftJsonError)
}

describe('Minecraft JSON boundary', () => {
  it('round-trips JSON values with every UTF-8 width', () => {
    const values = [null, true, false, 0, -1.5, 'ascii', 'é', '漢', '😀', [null, 1, 'é'], { value: '漢😀' }]
    for (const value of values) expect(decodeMinecraftJson(encodeMinecraftJson(value))).toStrictEqual(value)
  })

  it('accepts plain JSON values and rejects host objects and unsafe shapes', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype['value'] = 1
    expect(isMinecraftJsonValue(nullPrototype)).toBe(true)

    const shared = { value: 1 }
    expect(isMinecraftJsonValue({ first: shared, second: shared })).toBe(true)
    expect(isMinecraftJsonValue({})).toBe(true)
    expect(isMinecraftJsonValue([null, false, 1, 'value'])).toBe(true)

    const nullPrototypeArray: unknown[] = [1, 2]
    Object.setPrototypeOf(nullPrototypeArray, null)
    expect(isMinecraftJsonValue(nullPrototypeArray)).toBe(true)

    const customPrototypeArray: unknown[] = [1, 2]
    Object.setPrototypeOf(customPrototypeArray, { extra: true })
    expect(isMinecraftJsonValue(customPrototypeArray)).toBe(false)

    const sparse = new Array(1)
    const nonEnumerableIndexArray: unknown[] = [1]
    Object.defineProperty(nonEnumerableIndexArray, '0', { value: 1, enumerable: false, configurable: true })
    const extraArrayProperty = [1] as unknown as Record<string, unknown>
    extraArrayProperty['extra'] = true
    const customObject = Object.create({ inherited: true }) as Record<string, unknown>
    customObject['value'] = 1
    const accessor = {}
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 })
    const hidden = {}
    Object.defineProperty(hidden, 'value', { enumerable: false, value: 1 })
    const symbolKey = { value: 1, [Symbol('value')]: 2 }
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    const throwingProxy = new Proxy({ value: 1 }, { ownKeys: () => { throw new Error('proxy') } })
    const invalid: unknown[] = [
      undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      new Map(),
      new Set(),
      new Uint8Array([1]),
      sparse,
      nonEnumerableIndexArray,
      [undefined],
      extraArrayProperty,
      customObject,
      accessor,
      hidden,
      symbolKey,
      cycle,
      throwingProxy,
      () => 1,
    ]
    for (const value of invalid) expect(isMinecraftJsonValue(value)).toBe(false)
  })

  it('rejects invalid values before encoding', () => {
    expectJsonError(() => encodeMinecraftJson(Number.NaN))
    expectJsonError(() => encodeMinecraftJson({ value: 1n } as never))
    expectJsonError(() => encodeMinecraftJson(new Date() as never))
    expectJsonError(() => encodeMinecraftJson(new Array(1) as never))
  })

  it('rejects invalid input types, UTF-8, and JSON syntax while decoding', () => {
    expectJsonError(() => decodeMinecraftJson(null as never))
    const invalidUtf8 = [
      [0x80],
      [0xc2],
      [0xc2, 0x41],
      [0xe2, 0x82],
      [0xe2, 0x41, 0x82],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf0],
      [0xf0, 0x90, 0x80, 0x41],
      [0xf0, 0x80, 0x80, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xff],
    ]
    for (const bytes of invalidUtf8) expectJsonError(() => decodeMinecraftJson(Uint8Array.from(bytes)))
    expectJsonError(() => decodeMinecraftJson(new TextEncoder().encode('')))
    expectJsonError(() => decodeMinecraftJson(new TextEncoder().encode('{')))
    expectJsonError(() => decodeMinecraftJson(new TextEncoder().encode('undefined')))
  })

  it('guards the defensive JSON parse and stringify failure paths', () => {
    const parseSpy = vi.spyOn(JSON, 'parse').mockReturnValue(new Date() as never)
    try {
      expectJsonError(() => decodeMinecraftJson(new TextEncoder().encode('null')))
    } finally {
      parseSpy.mockRestore()
    }

    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('stringify failure')
    })
    try {
      expectJsonError(() => encodeMinecraftJson({ value: 1 }))
    } finally {
      stringifySpy.mockRestore()
    }

    const stringifyNonErrorSpy = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      // oxlint-disable-next-line no-throw-literal -- deliberately a non-Error, to hit encodeMinecraftJson's `String(error)` fallback.
      throw 'stringify string failure'
    })
    try {
      expect(() => encodeMinecraftJson({ value: 1 })).toThrow('stringify string failure')
    } finally {
      stringifyNonErrorSpy.mockRestore()
    }

    const stringifyUndefinedSpy = vi.spyOn(JSON, 'stringify').mockReturnValue(undefined as never)
    try {
      expect(() => encodeMinecraftJson({ value: 1 })).toThrow('value cannot be serialized as JSON')
    } finally {
      stringifyUndefinedSpy.mockRestore()
    }

    const parseNonErrorSpy = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      // oxlint-disable-next-line no-throw-literal -- deliberately a non-Error, to hit decodeMinecraftJson's `String(error)` fallback.
      throw 'parse string failure'
    })
    try {
      expect(() => decodeMinecraftJson(new TextEncoder().encode('null'))).toThrow('parse string failure')
    } finally {
      parseNonErrorSpy.mockRestore()
    }
  })

  it('guards the defensive Unicode scalar check while encoding UTF-8', () => {
    const fakeIterator = (): Iterator<string> => {
      let done = false
      return {
        next: (): IteratorResult<string> => {
          if (done) return { done: true, value: undefined }
          done = true
          return { done: false, value: '' }
        },
      }
    }
    const iteratorSpy = vi
      .spyOn(String.prototype, Symbol.iterator)
      .mockImplementation(fakeIterator as unknown as () => StringIterator<string>)
    try {
      expectJsonError(() => encodeMinecraftJson('anything'))
    } finally {
      iteratorSpy.mockRestore()
    }
  })
})
