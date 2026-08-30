import { Effect } from 'effect'
import type { SaveEnvelope } from './envelope.js'
import { SaveDecodeError } from './errors.js'
import { encodeSave, type SaveFormat } from './format.js'
import { DEFAULT_MAX_SAVE_BYTES, sealAndValidateSaveEnvelope } from './integrity.js'

export type SaveWriteOptions = {
  readonly extensions?: Readonly<Record<string, unknown>>
  readonly maxBytes?: number
}

export const prepareSave = <A, I>(
  format: SaveFormat<A, I>,
  value: A,
  options?: SaveWriteOptions,
): Effect.Effect<SaveEnvelope, SaveDecodeError> =>
  Effect.gen(function* () {
    const encoded = yield* encodeSave(format, value)
    return yield* sealAndValidateSaveEnvelope(
      encoded,
      options?.extensions,
      options?.maxBytes ?? DEFAULT_MAX_SAVE_BYTES,
    )
  })
