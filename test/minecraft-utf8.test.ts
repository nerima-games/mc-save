import { Result } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { decodeModifiedUtf8, encodeModifiedUtf8 } from '../src/domain/minecraft-utf8.js'

describe('Minecraft modified UTF-8 codec', () => {
  it('round-trips NUL, ASCII, BMP characters, and surrogate pairs', () => {
    const values = ['', '\0', 'ascii', 'é', '漢', '😀']

    for (const value of values) {
      const encoded = Result.getOrThrow(encodeModifiedUtf8(value))
      expect(Result.getOrThrow(decodeModifiedUtf8(encoded))).toBe(value)
    }

    expect(Result.getOrThrow(encodeModifiedUtf8('\0'))).toStrictEqual(new Uint8Array([0xc0, 0x80]))
    expect(Result.getOrThrow(encodeModifiedUtf8('😀'))).toStrictEqual(
      new Uint8Array([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]),
    )
  })

  it('rejects raw NUL, malformed continuations, truncated sequences, and overlong forms', () => {
    const invalid = [
      [0],
      [0x80],
      [0xc2],
      [0xc2, 0x41],
      [0xc1, 0x81],
      [0xe0, 0x80, 0x80],
      [0xe2, 0x82],
      [0xe2, 0x41, 0x82],
      [0xf0, 0x90, 0x80, 0x80],
    ]

    for (const bytes of invalid) expect(Result.isFailure(decodeModifiedUtf8(Uint8Array.from(bytes)))).toBe(true)
  })

  it('maps unreadable input and empty iterator elements to TypeError results', () => {
    expect(Result.isFailure(encodeModifiedUtf8(null))).toBe(true)

    const unreadableInput = new Uint8Array([0x61])
    Object.defineProperty(unreadableInput, 'slice', {
      value: () => {
        throw new Error('input copy failed')
      },
    })
    expect(Result.isFailure(decodeModifiedUtf8(unreadableInput))).toBe(true)

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
      expect(Result.isFailure(encodeModifiedUtf8('anything'))).toBe(true)
    } finally {
      iteratorSpy.mockRestore()
    }
  })

  it('rejects non-byte input and an unreadable copied byte', () => {
    const nonByteInput = new Proxy(new Uint8Array(), { getPrototypeOf: () => Object.prototype })
    expect(Result.isFailure(decodeModifiedUtf8(nonByteInput))).toBe(true)

    const bytesWithMissingIndex = new Proxy(new Uint8Array([0x61]), {
      get: (target, key) => (key === '0' ? undefined : Reflect.get(target, key, target)),
    })
    const input = new Uint8Array([0x61])
    Object.defineProperty(input, 'slice', { value: () => bytesWithMissingIndex })

    expect(Result.isFailure(decodeModifiedUtf8(input))).toBe(true)
  })
})
