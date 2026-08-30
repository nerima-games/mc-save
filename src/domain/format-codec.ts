import { Effect, Schema } from 'effect'
import {
  isFromFuture,
  SaveEnvelopeDraftSchema,
  saveEnvelope,
  type SaveEnvelopeDraft,
} from './envelope.js'
import { SaveDecodeError } from './errors.js'
import type { SaveFormat } from './format-types.js'
import { canonicalize } from './integrity-canonical.js'

const validateEncodedPayload = (
  format: string,
  version: number,
  payload: unknown,
): Effect.Effect<void, SaveDecodeError> => {
  try {
    const canonical = canonicalize(payload)
    if (canonical.containsInvalidNumber) {
      return Effect.fail(
        new SaveDecodeError({
          format,
          version,
          reason: 'save contains a non-finite number',
        }),
      )
    }
    return Effect.succeed(undefined)
  } catch (cause) {
    return Effect.fail(
      new SaveDecodeError({
        format,
        version,
        reason: cause instanceof Error ? cause.message : 'the encoded value is not storage-compatible',
        cause,
      }),
    )
  }
}

export const encodeSave = <A, I>(
  format: SaveFormat<A, I>,
  value: A,
): Effect.Effect<SaveEnvelopeDraft, SaveDecodeError> =>
  Schema.encode(format.schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new SaveDecodeError({
          format: format.name,
          version: format.version,
          reason: 'the value does not satisfy the format schema, so it cannot be encoded',
          cause,
        }),
    ),
    Effect.flatMap((encoded) =>
      validateEncodedPayload(format.name, format.version, encoded).pipe(
        Effect.map(() => saveEnvelope(format.name, format.version, encoded)),
      ),
    ),
  )

export const decodeSave = <A, I>(
  format: SaveFormat<A, I>,
  value: unknown,
): Effect.Effect<A, SaveDecodeError> =>
  Effect.gen(function* () {
    const envelope = yield* Schema.decodeUnknown(SaveEnvelopeDraftSchema)(value).pipe(
      Effect.mapError(
        (cause) =>
          new SaveDecodeError({
            format: format.name,
            version: format.version,
            reason: 'the value is not a well-formed save envelope',
            cause,
          }),
      ),
    )

    if (envelope.format !== format.name) {
      return yield* new SaveDecodeError({
        format: format.name,
        version: envelope.version,
        reason: `envelope belongs to format "${envelope.format}", not "${format.name}"`,
      })
    }

    if (isFromFuture(envelope, format.version)) {
      return yield* new SaveDecodeError({
        format: format.name,
        version: envelope.version,
        reason: `this save was written by a newer build (v${envelope.version} > v${format.version}). It is not corrupt and must not be offered for deletion — it needs a newer version of the game.`,
      })
    }

    if (envelope.version !== format.version) {
      return yield* new SaveDecodeError({
        format: format.name,
        version: envelope.version,
        reason: `this save uses unsupported version v${envelope.version}; current version is v${format.version}; only the current format version is accepted`,
      })
    }

    return yield* Schema.decodeUnknown(format.schema)(envelope.payload).pipe(
      Effect.mapError(
        (cause) =>
          new SaveDecodeError({
            format: format.name,
            version: envelope.version,
            reason: 'the payload does not satisfy the current schema',
            cause,
          }),
      ),
    )
  })
