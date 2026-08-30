import { describe, expect, it } from 'vitest'
import {
  errorReason,
  MinecraftJavaSaveError,
  minecraftJavaSaveError,
  throwMinecraftJavaSaveError,
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

  it('throws the constructed error from throwMinecraftJavaSaveError', () => {
    expect(() => throwMinecraftJavaSaveError('validate', 'bad shape')).toThrowError(MinecraftJavaSaveError)
    expect(() => throwMinecraftJavaSaveError('validate', 'bad shape', 'a/b')).toThrow('bad shape')
  })

  it('extracts the reason from Error instances and non-Error values', () => {
    expect(errorReason(new Error('inner failure'))).toBe('inner failure')
    expect(errorReason('plain string reason')).toBe('plain string reason')
    expect(errorReason(42)).toBe('42')
    expect(errorReason(null)).toBe('null')
  })
})
