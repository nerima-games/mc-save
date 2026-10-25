import { WorldId } from '@nerima-games/mc-kernel'
import { Brand, Result } from 'effect'
import { EncodedSaveKeySegment, SaveKeyNamespace, SaveKeySegment, ValidationMessage } from './brand-types.js'

// TypeScript intentionally permits the public constructor and branded type to share this name.
// oxlint's no-redeclare rule does not model that type/value namespace distinction.
// oxlint-disable no-redeclare
export type SaveKey = string & Brand.Brand<'SaveKey'>

export const SaveKey: Brand.Constructor<SaveKey> = Brand.make<SaveKey>(
  (value) => typeof value === 'string' && value.trim().length > 0 || 'save key must be non-blank',
)
// oxlint-enable no-redeclare

const encodeSegment = (
  segment: SaveKeyNamespace | SaveKeySegment | WorldId,
): Result.Result<EncodedSaveKeySegment, ValidationMessage> =>
  Result.flatMap(
    Result.mapError(
      SaveKeySegment.result(segment),
      () => ValidationMessage('save key segment must be a string'),
    ),
    (checkedSegment) =>
      Result.flatMap(
        Result.try({
          try: () => encodeURIComponent(checkedSegment),
          catch: () => ValidationMessage('save key segment could not be encoded'),
        }),
        (value) => Result.succeed(Brand.nominal<EncodedSaveKeySegment>()(value)),
      ),
  )

export const saveKeyForWorld = (
  worldId: WorldId,
  namespace: SaveKeyNamespace,
  segments: ReadonlyArray<SaveKeySegment> = [],
): Result.Result<SaveKey, ValidationMessage> => {
  if (typeof worldId !== 'string') {
    return Result.fail(ValidationMessage('world id must be valid'))
  }
  const checkedWorldId = Result.mapError(
    WorldId.result(worldId),
    () => ValidationMessage('world id must be valid'),
  )
  if (Result.isFailure(checkedWorldId)) return Result.fail(checkedWorldId.failure)

  const checkedNamespace = Result.mapError(
    SaveKeyNamespace.result(namespace),
    () => ValidationMessage('save key namespace must be non-blank'),
  )
  if (Result.isFailure(checkedNamespace)) return Result.fail(checkedNamespace.failure)

  const capturedSegments = Result.try({
    try: () => Array.from(segments),
    catch: () => ValidationMessage('save key segments could not be read'),
  })
  if (Result.isFailure(capturedSegments)) return Result.fail(capturedSegments.failure)

  const encodedSegments: Array<EncodedSaveKeySegment> = []
  for (const segment of [checkedNamespace.success, checkedWorldId.success, ...capturedSegments.success]) {
    const encoded = encodeSegment(segment)
    if (Result.isFailure(encoded)) return Result.fail(encoded.failure)
    encodedSegments.push(encoded.success)
  }

  return Result.succeed(SaveKey(encodedSegments.join('/')))
}
