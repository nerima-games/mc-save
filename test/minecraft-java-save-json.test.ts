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

    const sparse = new Array(1)
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
  })
})
