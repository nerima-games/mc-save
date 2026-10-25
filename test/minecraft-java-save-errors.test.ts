import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  errorReason,
  MinecraftJavaSaveError,
  minecraftJavaSaveError,
} from '../src/domain/minecraft-java-save-errors.js'

const unwrapSuccess = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isSuccess(result)) return result.success
  throw new Error('expected a successful Result')
}

describe('Minecraft Java save error helpers', () => {
  it('formats the message with and without a path', () => {
    const withPath = unwrapSuccess(minecraftJavaSaveError('decode', 'boom', 'level.dat'))
    expect(withPath.message).toBe('Minecraft Java save decode failed at level.dat: boom')
    expect(withPath.path).toBe('level.dat')

    const withoutPath = unwrapSuccess(minecraftJavaSaveError('encode', 'boom'))
    expect(withoutPath.message).toBe('Minecraft Java save encode failed: boom')
    expect(withoutPath.path).toBeUndefined()
  })

  it('constructs the tagged failure used by Result and Effect', () => {
    const error = unwrapSuccess(minecraftJavaSaveError('validate', 'bad shape', 'a/b'))
    expect(error).toBeInstanceOf(MinecraftJavaSaveError)
    expect(error._tag).toBe('MinecraftJavaSaveError')
    expect(error.operation).toBe('validate')
    expect(error.reason).toBe('bad shape')
    expect(error.path).toBe('a/b')
  })

  it('extracts the reason from Error instances and non-Error values', () => {
    expect(unwrapSuccess(errorReason(new Error('inner failure')))).toBe('inner failure')
    expect(unwrapSuccess(errorReason('plain string reason'))).toBe('plain string reason')
    expect(unwrapSuccess(errorReason(42))).toBe('42')
    expect(unwrapSuccess(errorReason(null))).toBe('null')
  })

  it('keeps an error formatting failure in the Result failure channel', () => {
    const hostile = {
      toString: () => {
        throw new Error('hostile toString')
      },
    }
    const result = errorReason(hostile)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(TypeError)
  })

  it('keeps unformattable error reasons and paths in the Result failure channel', () => {
    const hostile = {
      toString: () => {
        throw new Error('hostile toString')
      },
    }
    const reasonResult = minecraftJavaSaveError('encode', hostile)
    const pathResult = minecraftJavaSaveError('decode', 'bad input', hostile)
    const malformedError = new Error()
    Object.defineProperty(malformedError, 'message', { value: 42 })
    const errorReasonResult = errorReason(malformedError)

    expect(Result.isFailure(reasonResult)).toBe(true)
    if (Result.isFailure(reasonResult)) expect(reasonResult.failure).toBeInstanceOf(TypeError)
    expect(Result.isFailure(pathResult)).toBe(true)
    if (Result.isFailure(pathResult)) expect(pathResult.failure).toBeInstanceOf(TypeError)
    expect(Result.isFailure(errorReasonResult)).toBe(true)
    if (Result.isFailure(errorReasonResult)) expect(errorReasonResult.failure).toBeInstanceOf(TypeError)
  })
})
