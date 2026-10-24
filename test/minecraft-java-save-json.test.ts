import { Result } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeMinecraftJson as decodeMinecraftJsonResult,
  encodeMinecraftJson as encodeMinecraftJsonResult,
  isMinecraftJsonValue,
  MinecraftJsonError,
} from '../src/domain/minecraft-java-save-json.js'

const unwrapResult = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const decodeMinecraftJson = (...args: Parameters<typeof decodeMinecraftJsonResult>) =>
  unwrapResult(decodeMinecraftJsonResult(...args))
const encodeMinecraftJson = (...args: Parameters<typeof encodeMinecraftJsonResult>) =>
  unwrapResult(encodeMinecraftJsonResult(...args))

const expectJsonError = (operation: () => unknown): void => {
  expect(operation).toThrowError(MinecraftJsonError)
}

describe('Minecraft JSON boundary', () => {
  it('round-trips JSON values with every UTF-8 width', () => {
    const values = [null, true, false, 0, -1.5, 'ascii', 'é', '漢', '😀', [null, 1, 'é'], { value: '漢😀' }]
    for (const value of values) expect(decodeMinecraftJson(encodeMinecraftJson(value))).toStrictEqual(value)
  })

  it('accepts plain JSON values and rejects host objects and unsafe shapes', () => {
    const nullPrototype: Record<string, unknown> = Object.create(null)
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
    const extraArrayProperty = Object.assign([1], { extra: true })
    const customObject: Record<string, unknown> = Object.create({ inherited: true })
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
    // @ts-expect-error -- bigint is not JSON-safe; verifies runtime rejection
    expectJsonError(() => encodeMinecraftJson({ value: 1n }))
    // @ts-expect-error -- deliberately wrong type to verify runtime rejection
    expectJsonError(() => encodeMinecraftJson(new Date()))
    expectJsonError(() => encodeMinecraftJson(new Array(1)))
  })

  it('rejects invalid input types, UTF-8, and JSON syntax while decoding', () => {
    // @ts-expect-error -- deliberately wrong type to verify runtime rejection
    expectJsonError(() => decodeMinecraftJson(null))
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
    const parseSpy = vi.spyOn(JSON, 'parse').mockReturnValue(new Date())
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

    // @ts-expect-error -- JSON.stringify is typed to always return string; this forces the runtime-undefined path
    const stringifyUndefinedSpy = vi.spyOn(JSON, 'stringify').mockReturnValue(undefined)
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
    const fakeIterator = (): StringIterator<string> => {
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
    const iteratorSpy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(fakeIterator)
    try {
      expectJsonError(() => encodeMinecraftJson('anything'))
    } finally {
      iteratorSpy.mockRestore()
    }
  })

  it('maps JSON snapshot and UTF-8 allocation failures to MinecraftJsonError', () => {
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
      throw new Error('snapshot failed')
    })
    try {
      expectJsonError(() => encodeMinecraftJson({ value: 1 }))
    } finally {
      cloneSpy.mockRestore()
    }

    const allocationSpy = vi.spyOn(Uint8Array, 'from').mockImplementation(() => {
      throw new Error('allocation failed')
    })
    try {
      expectJsonError(() => encodeMinecraftJson('small string'))
    } finally {
      allocationSpy.mockRestore()
    }
  })

  it('rejects decoded JSON text that exceeds the runtime code-point argument limit', () => {
    const bytes = new TextEncoder().encode('"' + 'a'.repeat(200_000) + '"')
    expectJsonError(() => decodeMinecraftJson(bytes))
  })


  it('maps revoked JSON proxies and unreadable decoded bytes to boundary failures', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(isMinecraftJsonValue(revoked.proxy)).toBe(false)

    const uncopiableBytes = new Uint8Array([0x6e])
    Object.defineProperty(uncopiableBytes, 'slice', {
      value: () => {
        throw new Error('decode input copy failed')
      },
    })
    expectJsonError(() => decodeMinecraftJson(uncopiableBytes))
  })

  it('rejects missing indexed bytes in copied UTF-8 snapshots', () => {
    const missingByte = (bytes: Uint8Array, index: number): Uint8Array => {
      const snapshot = new Proxy(bytes.slice(), {
        get(target, property) {
          if (property === 'byteLength') return target.byteLength
          if (property === String(index)) return undefined
          return Reflect.get(target, property, target)
        },
      })
      const input = bytes.slice()
      Object.defineProperty(input, 'slice', { value: () => snapshot })
      return input
    }

    expectJsonError(() => decodeMinecraftJson(missingByte(Uint8Array.from([0x41]), 0)))
    expectJsonError(() => decodeMinecraftJson(missingByte(Uint8Array.from([0xc2, 0x80]), 1)))
    expectJsonError(() => decodeMinecraftJson(missingByte(Uint8Array.from([0xe2, 0x82, 0xac]), 1)))
    expectJsonError(() => decodeMinecraftJson(missingByte(Uint8Array.from([0xe2, 0x82, 0xac]), 2)))
    expectJsonError(() => decodeMinecraftJson(missingByte(Uint8Array.from([0xf0, 0x90, 0x80, 0x80]), 1)))
    expectJsonError(() => decodeMinecraftJson(missingByte(Uint8Array.from([0xf0, 0x90, 0x80, 0x80]), 2)))
    expectJsonError(() => decodeMinecraftJson(missingByte(Uint8Array.from([0xf0, 0x90, 0x80, 0x80]), 3)))
  })

})
