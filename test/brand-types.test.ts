import { describe, expect, it } from 'vitest'
import { Result } from 'effect'
import {
  CanonicalizationIssue,
  EncodedByteSequence,
  EncodedSaveKeySegment,
  IndexedDbDatabaseName,
  IndexedDbDatabaseVersion,
  IndexedDbFieldName,
  SaveErrorFormatLabel,
  SaveErrorVersion,
  StorageOperation,
  ValidationMessage,
} from '../src/domain/brand-types.js'

const expectFailure = <Success, Failure>(result: Result.Result<Success, Failure>) => {
  expect(Result.isFailure(result)).toBe(true)
}

describe('branded save values', () => {
  it('rejects non-string error labels and validation messages through Result', () => {
    expectFailure(SaveErrorFormatLabel.result(null as unknown as string))
    expectFailure(ValidationMessage.result(null as unknown as string))
  })

  it('rejects invalid save error versions', () => {
    expectFailure(SaveErrorVersion.result(-1))
    expectFailure(SaveErrorVersion.result(Number.MAX_SAFE_INTEGER + 1))
  })

  it('rejects non-string encoded save-key segments', () => {
    expectFailure(EncodedSaveKeySegment.result(null as unknown as string))
  })

  it('rejects blank storage operations', () => {
    expectFailure(StorageOperation.result('   '))
  })

  it('rejects empty IndexedDB database names and invalid versions', () => {
    expectFailure(IndexedDbDatabaseName.result(''))
    expectFailure(IndexedDbDatabaseVersion.result(0))
    expectFailure(IndexedDbDatabaseVersion.result(Number.MAX_SAFE_INTEGER + 1))
  })

  it('rejects non-string IndexedDB field names', () => {
    expectFailure(IndexedDbFieldName.result(null as unknown as string))
  })

  it('rejects non-arrays and invalid values in encoded byte sequences', () => {
    expectFailure(EncodedByteSequence.result('not bytes' as unknown as ReadonlyArray<number>))
    expectFailure(EncodedByteSequence.result([256]))
  })

  it('returns a brand failure when an encoded byte sequence cannot be read', () => {
    const unreadable = new Proxy([] as Array<number>, {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('unreadable byte sequence')
        return Reflect.get(target, property, receiver)
      },
    })

    expectFailure(EncodedByteSequence.result(unreadable))
  })

  it('rejects non-string canonicalization issues', () => {
    expectFailure(CanonicalizationIssue.result(null as unknown as string))
  })
})
