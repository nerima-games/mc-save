import { describe, expect, it } from 'vitest'
import { WorldId } from '@nerima-games/mc-kernel'
import { SaveKey, saveKeyForWorld } from '../src/index.js'

describe('saveKeyForWorld', () => {
  it('preserves the shared world-scoped layout while encoding each segment', () => {
    const worldId = WorldId('world/east')

    expect(saveKeyForWorld(worldId, 'chunk', ['overworld', '-2', '3'])).toBe(
      'chunk/world%2Feast/overworld/-2/3',
    )
  })

  it('supports a namespace without additional segments', () => {
    expect(saveKeyForWorld(WorldId('world'), 'metadata')).toBe('metadata/world')
  })

  it('retains SaveKey validation as the public constructor', () => {
    expect(SaveKey('manual-key')).toBe('manual-key')
    expect(() => SaveKey('   ')).toThrow()
  })
})
