import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { ValidationMessage } from '../src/domain/brand-types.js'
import { assertDefined } from '../src/domain/assert-defined.js'

describe('assertDefined', () => {
  it('returns the value unchanged when it is defined', () => {
    expect(assertDefined(0, ValidationMessage('zero'))).toEqual(Result.succeed(0))
    expect(assertDefined('', ValidationMessage('empty string'))).toEqual(Result.succeed(''))
    expect(assertDefined(null, ValidationMessage('null'))).toEqual(Result.succeed(null))
    const object = { key: 'value' }
    expect(assertDefined(object, ValidationMessage('object'))).toEqual(Result.succeed(object))
  })

  it('throws a plain Error carrying the caller-supplied description when the value is undefined', () => {
    expect(assertDefined(undefined, ValidationMessage('index 3 of a length-4 array'))).toEqual(
      Result.fail(ValidationMessage('index 3 of a length-4 array')),
    )
    expect(assertDefined(undefined, ValidationMessage('anything'))).toEqual(
      Result.fail(ValidationMessage('anything')),
    )
  })
})
