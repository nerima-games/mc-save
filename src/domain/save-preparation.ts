import { Effect } from 'effect'
import type { JsonFieldName, SaveMaxBytes } from './brand-types.js'
import type { SaveEnvelope } from './envelope.js'
import { SaveDecodeError } from './errors.js'
import { encodeSave, type SaveFormat } from './format.js'
import { resolveSaveMaxBytes, sealAndValidateSaveEnvelope, validateSaveExtensions } from './integrity.js'

export type SaveWriteOptions = {
  readonly extensions?: Readonly<Record<JsonFieldName, unknown>>
  readonly maxBytes?: SaveMaxBytes
}

export const prepareSave = <A, I>(
  format: SaveFormat<A, I>,
  value: A,
  options?: SaveWriteOptions,
): Effect.Effect<SaveEnvelope, SaveDecodeError> =>
  Effect.gen(function* () {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Effect.fail(new SaveDecodeError({
        format: format.name,
        version: format.version,
        reason: 'save write options could not be read',
        cause: new TypeError('options must be an object'),
      }))
    }
    const fields = yield* Effect.try({
      try: () => options === undefined
        ? { extensions: undefined, maxBytes: undefined }
        : {
            extensions: Reflect.get(options, 'extensions'),
            maxBytes: Reflect.get(options, 'maxBytes'),
          },
      catch: (cause) => new SaveDecodeError({
        format: format.name,
        version: format.version,
        reason: 'save write options could not be read',
        cause,
      }),
    })
    const extensions = yield* Effect.fromResult(validateSaveExtensions(format.name, format.version, fields.extensions))
    const maxBytes = yield* Effect.fromResult(resolveSaveMaxBytes(fields.maxBytes, format.name, format.version))
    const encoded = yield* encodeSave(format, value)
    return yield* sealAndValidateSaveEnvelope(
      encoded,
      extensions,
      maxBytes,
    )
  })
