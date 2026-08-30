import { describe, expect, it } from 'vitest'
import { assertDefined } from '../src/domain/assert-defined.js'

describe('assertDefined', () => {
  it('returns the value unchanged when it is defined', () => {
    expect(assertDefined(0, 'zero')).toBe(0)
    expect(assertDefined('', 'empty string')).toBe('')
    expect(assertDefined(null, 'null')).toBeNull()
    const object = { key: 'value' }
    expect(assertDefined(object, 'object')).toBe(object)
  })

  it('throws a plain Error carrying the caller-supplied description when the value is undefined', () => {
    expect(() => assertDefined(undefined, 'index 3 of a length-4 array')).toThrow(
      new Error('index 3 of a length-4 array'),
    )
    expect(() => assertDefined(undefined, 'anything')).toThrow(Error)
  })
})
