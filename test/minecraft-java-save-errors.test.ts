import { describe, expect, it } from 'vitest'
import {
  errorReason,
  MinecraftJavaSaveError,
  minecraftJavaSaveError,
} from '../src/domain/minecraft-java-save-errors.js'

describe('Minecraft Java save error helpers', () => {
  it('formats the message with and without a path', () => {
    const withPath = minecraftJavaSaveError('decode', 'boom', 'level.dat')
    expect(withPath.message).toBe('Minecraft Java save decode failed at level.dat: boom')
    expect(withPath.path).toBe('level.dat')

    const withoutPath = minecraftJavaSaveError('encode', 'boom')
    expect(withoutPath.message).toBe('Minecraft Java save encode failed: boom')
    expect(withoutPath.path).toBeUndefined()
  })

  it('constructs the tagged failure used by Result and Effect', () => {
    const error = minecraftJavaSaveError('validate', 'bad shape', 'a/b')
    expect(error).toBeInstanceOf(MinecraftJavaSaveError)
    expect(error._tag).toBe('MinecraftJavaSaveError')
    expect(error.operation).toBe('validate')
    expect(error.reason).toBe('bad shape')
    expect(error.path).toBe('a/b')
  })

  it('extracts the reason from Error instances and non-Error values', () => {
    expect(errorReason(new Error('inner failure'))).toBe('inner failure')
    expect(errorReason('plain string reason')).toBe('plain string reason')
    expect(errorReason(42)).toBe('42')
    expect(errorReason(null)).toBe('null')
  })

  it('returns a stable reason when an unknown error cannot be stringified', () => {
    const hostile = {
      toString: () => {
        throw new Error('hostile toString')
      },
    }
    expect(errorReason(hostile)).toBe('operation failed')
  })
})
