import { describe, expect, it } from 'vitest'
import { Result } from 'effect'
import { applyUntrustedArgument } from './support/apply-untrusted-argument.js'
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
    expectFailure(applyUntrustedArgument(SaveErrorFormatLabel.result, SaveErrorFormatLabel, [null]))
    expectFailure(applyUntrustedArgument(ValidationMessage.result, ValidationMessage, [null]))
  })

  it('rejects invalid save error versions', () => {
    expectFailure(SaveErrorVersion.result(-1))
    expectFailure(SaveErrorVersion.result(Number.MAX_SAFE_INTEGER + 1))
  })

  it('rejects non-string encoded save-key segments', () => {
    expectFailure(applyUntrustedArgument(EncodedSaveKeySegment.result, EncodedSaveKeySegment, [null]))
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
    expectFailure(applyUntrustedArgument(IndexedDbFieldName.result, IndexedDbFieldName, [null]))
  })

  it('rejects non-arrays and invalid values in encoded byte sequences', () => {
    expectFailure(applyUntrustedArgument(EncodedByteSequence.result, EncodedByteSequence, ['not bytes']))
    expectFailure(EncodedByteSequence.result([256]))
  })

  it('returns a brand failure when an encoded byte sequence cannot be read', () => {
    const unreadable = new Proxy<Array<number>>([], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('unreadable byte sequence')
        return Reflect.get(target, property, receiver)
      },
    })

    expectFailure(EncodedByteSequence.result(unreadable))
  })

  it('rejects non-string canonicalization issues', () => {
    expectFailure(applyUntrustedArgument(CanonicalizationIssue.result, CanonicalizationIssue, [null]))
  })
})
