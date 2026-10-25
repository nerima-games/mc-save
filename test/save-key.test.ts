import { describe, expect, it } from 'vitest'
import { WorldId } from '@nerima-games/mc-kernel'
import { Result } from 'effect'
import { SaveKey, SaveKeyNamespace, SaveKeySegment, saveKeyForWorld } from '../src/index.js'

const keyNamespace = (value: string) => Result.getOrThrow(SaveKeyNamespace.result(value))
const keySegment = (value: string) => Result.getOrThrow(SaveKeySegment.result(value))

describe('saveKeyForWorld', () => {
  it('preserves the shared world-scoped layout while encoding each segment', () => {
    const worldId = WorldId('world/east')

    expect(
      Result.getOrThrow(
        saveKeyForWorld(worldId, keyNamespace('chunk'), [
          keySegment('overworld'),
          keySegment('-2'),
          keySegment('3'),
        ]),
      ),
    ).toBe('chunk/world%2Feast/overworld/-2/3')
  })

  it('supports a namespace without additional segments', () => {
    expect(Result.getOrThrow(saveKeyForWorld(WorldId('world'), keyNamespace('metadata')))).toBe('metadata/world')
  })

  it('retains SaveKey validation as the public constructor', () => {
    expect(SaveKey('manual-key')).toBe('manual-key')
    expect(() => SaveKey('   ')).toThrow()
  })
})
