import { Brand, Result } from 'effect'

export type JsonFieldName = string & Brand.Brand<'JsonFieldName'>
export const JsonFieldName: Brand.Constructor<JsonFieldName> = Brand.make(
  (value) => typeof value === 'string' || 'JSON field name must be a string',
)

export type SaveFormatName = string & Brand.Brand<'SaveFormatName'>
export const SaveFormatName: Brand.Constructor<SaveFormatName> = Brand.make(
  (value) => typeof value === 'string' && value.trim().length > 0 || 'Save envelope format must be a non-blank string',
)

export type SaveFormatVersion = number & Brand.Brand<'SaveFormatVersion'>
export const SaveFormatVersion: Brand.Constructor<SaveFormatVersion> = Brand.make(
  (value) => Number.isSafeInteger(value) && value >= 1 || 'Save envelope version must be a positive safe integer',
)

export type SaveByteLength = number & Brand.Brand<'SaveByteLength'>
export const SaveByteLength: Brand.Constructor<SaveByteLength> = Brand.make(
  (value) => Number.isSafeInteger(value) && value >= 0 || 'Save integrity byte length must be a non-negative safe integer',
)

export type SaveMaxBytes = number & Brand.Brand<'SaveMaxBytes'>
export const SaveMaxBytes: Brand.Constructor<SaveMaxBytes> = Brand.make(
  (value) => Number.isSafeInteger(value) && value >= 0 || 'maximum save size must be a non-negative safe integer',
)

export type SaveChecksum = string & Brand.Brand<'SaveChecksum'>
export const SaveChecksum: Brand.Constructor<SaveChecksum> = Brand.make(
  (value) =>
    (typeof value === 'string' && /^[0-9a-f]{8}$/u.test(value)) ||
    'save checksum must be eight lowercase hexadecimal characters',
)

export type ValidationMessage = string & Brand.Brand<'ValidationMessage'>
export const ValidationMessage: Brand.Constructor<ValidationMessage> = Brand.make(
  (value) => typeof value === 'string' || 'validation message must be a string',
)

export type SaveErrorFormatLabel = string & Brand.Brand<'SaveErrorFormatLabel'>
export const SaveErrorFormatLabel: Brand.Constructor<SaveErrorFormatLabel> = Brand.make(
  (value) => typeof value === 'string' || 'save error format label must be a string',
)

export type SaveErrorVersion = number & Brand.Brand<'SaveErrorVersion'>
export const SaveErrorVersion: Brand.Constructor<SaveErrorVersion> = Brand.make(
  (value) => Number.isSafeInteger(value) && value >= 0 || 'save error version must be a non-negative safe integer',
)

export type SaveKeyNamespace = string & Brand.Brand<'SaveKeyNamespace'>
export const SaveKeyNamespace: Brand.Constructor<SaveKeyNamespace> = Brand.make(
  (value) => typeof value === 'string' && value.trim().length > 0 || 'save key namespace must be non-blank',
)

export type SaveKeySegment = string & Brand.Brand<'SaveKeySegment'>
export const SaveKeySegment: Brand.Constructor<SaveKeySegment> = Brand.make(
  (value) => typeof value === 'string' || 'save key segment must be a string',
)

export type EncodedSaveKeySegment = string & Brand.Brand<'EncodedSaveKeySegment'>
export const EncodedSaveKeySegment: Brand.Constructor<EncodedSaveKeySegment> = Brand.make(
  (value) => typeof value === 'string' || 'encoded save key segment must be a string',
)

export type StorageOperation = string & Brand.Brand<'StorageOperation'>
export const StorageOperation: Brand.Constructor<StorageOperation> = Brand.make(
  (value) => typeof value === 'string' && value.trim().length > 0 || 'storage operation must be non-blank',
)

export type IndexedDbDatabaseName = string & Brand.Brand<'IndexedDbDatabaseName'>
export const IndexedDbDatabaseName: Brand.Constructor<IndexedDbDatabaseName> = Brand.make(
  (value) => typeof value === 'string' && value.length > 0 || 'IndexedDB database name must be non-empty',
)

export type IndexedDbDatabaseVersion = number & Brand.Brand<'IndexedDbDatabaseVersion'>
export const IndexedDbDatabaseVersion: Brand.Constructor<IndexedDbDatabaseVersion> = Brand.make(
  (value) => Number.isSafeInteger(value) && value >= 1 || 'IndexedDB database version must be a positive safe integer',
)

export type IndexedDbFieldName = string & Brand.Brand<'IndexedDbFieldName'>
export const IndexedDbFieldName: Brand.Constructor<IndexedDbFieldName> = Brand.make(
  (value) => typeof value === 'string' || 'IndexedDB field name must be a string',
)

export type StorageSequence = number & Brand.Brand<'StorageSequence'>
export const StorageSequence: Brand.Constructor<StorageSequence> = Brand.make(
  (value) => Number.isSafeInteger(value) && value >= 0 || 'storage sequence must be a non-negative safe integer',
)

export type ByteValue = number & Brand.Brand<'ByteValue'>
export const ByteValue: Brand.Constructor<ByteValue> = Brand.make(
  (value) => Number.isSafeInteger(value) && value >= 0 && value <= 255 || 'byte value must be an integer from 0 through 255',
)

export type ByteBuffer = Uint8Array & Brand.Brand<'ByteBuffer'>
export const ByteBuffer: Brand.Constructor<ByteBuffer> = Brand.make(
  (value) => value instanceof Uint8Array || 'byte buffer must be a Uint8Array',
)

export type EncodedByteSequence = ReadonlyArray<number> & Brand.Brand<'EncodedByteSequence'>
export const EncodedByteSequence: Brand.Constructor<EncodedByteSequence> = Brand.make((value) => {
  const checked = Result.try({
    try: () => {
      if (!Array.isArray(value)) return 'encoded byte sequence must be an array'
      const length = value.length
      for (let index = 0; index < length; index += 1) {
        const byte: unknown = value[index]
        if (
          typeof byte !== 'number' ||
          !Number.isSafeInteger(byte) ||
          byte < 0 ||
          byte > 255
        ) {
          return 'encoded byte sequence must contain only integers from 0 through 255'
        }
      }
      return true
    },
    catch: () => 'encoded byte sequence could not be read',
  })
  return Result.isFailure(checked) ? checked.failure : checked.success
})

export type CanonicalJson = string & Brand.Brand<'CanonicalJson'>
export const CanonicalJson: Brand.Constructor<CanonicalJson> = Brand.make(
  (value) => typeof value === 'string' || 'canonical JSON must be a string',
)

export type CanonicalizationIssue = string & Brand.Brand<'CanonicalizationIssue'>
export const CanonicalizationIssue: Brand.Constructor<CanonicalizationIssue> = Brand.make(
  (value) => typeof value === 'string' || 'canonicalization issue must be a string',
)
