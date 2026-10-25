import { describe, expect, it } from 'vitest'
import { WorldId } from '@nerima-games/mc-kernel'
import { Result } from 'effect'
import { SaveKey, SaveKeyNamespace, SaveKeySegment, saveKeyForWorld } from '../src/index.js'
import { applyUntrustedArgument } from './support/apply-untrusted-argument.js'

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

  it('retains validation in the public SaveKey constructor', () => {
    expect(SaveKey('manual-key')).toBe('manual-key')
    expect(() => SaveKey('   ')).toThrow()
    expect(Result.isFailure(SaveKey.result('   '))).toBe(true)
  })

  it('returns validation failures for an invalid world id and namespace', () => {
    const invalidWorld = applyUntrustedArgument(saveKeyForWorld, undefined, [null, keyNamespace('chunk')])
    const blankWorld = applyUntrustedArgument(saveKeyForWorld, undefined, ['  ', keyNamespace('chunk')])
    const invalidNamespace = applyUntrustedArgument(saveKeyForWorld, undefined, [WorldId('world'), '   '])

    expect(Result.isFailure(invalidWorld) && invalidWorld.failure).toBe('world id must be valid')
    expect(Result.isFailure(blankWorld) && blankWorld.failure).toBe('world id must be valid')
    expect(Result.isFailure(invalidNamespace) && invalidNamespace.failure).toBe('save key namespace must be non-blank')
  })

  it('uses the empty segment list only when the argument is omitted', () => {
    const omitted = saveKeyForWorld(WorldId('world'), keyNamespace('metadata'))
    const explicitNull = applyUntrustedArgument(saveKeyForWorld, undefined, [
      WorldId('world'),
      keyNamespace('metadata'),
      null,
    ])

    expect(Result.getOrThrow(omitted)).toBe('metadata/world')
    expect(Result.isFailure(explicitNull) && explicitNull.failure).toBe('save key segments could not be read')
  })

  it('returns a validation failure when a segment is not a string', () => {
    const result = applyUntrustedArgument(saveKeyForWorld, undefined, [WorldId('world'), keyNamespace('chunk'), [null]])

    expect(Result.isFailure(result) && result.failure).toBe('save key segment must be a string')
  })

  it('returns a validation failure when a segment cannot be URI-encoded', () => {
    const result = saveKeyForWorld(WorldId('world'), keyNamespace('chunk'), [keySegment('\ud800')])

    expect(Result.isFailure(result) && result.failure).toBe('save key segment could not be encoded')
  })
})
