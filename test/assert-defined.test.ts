import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { assertDefined } from '../src/domain/assert-defined.js'

describe('assertDefined', () => {
  it('returns the value unchanged when it is defined', () => {
    expect(assertDefined(0, 'zero')).toEqual(Result.succeed(0))
    expect(assertDefined('', 'empty string')).toEqual(Result.succeed(''))
    expect(assertDefined(null, 'null')).toEqual(Result.succeed(null))
    const object = { key: 'value' }
    expect(assertDefined(object, 'object')).toEqual(Result.succeed(object))
  })

  it('throws a plain Error carrying the caller-supplied description when the value is undefined', () => {
    expect(assertDefined(undefined, 'index 3 of a length-4 array')).toEqual(
      Result.fail('index 3 of a length-4 array'),
    )
    expect(assertDefined(undefined, 'anything')).toEqual(Result.fail('anything'))
  })
})
