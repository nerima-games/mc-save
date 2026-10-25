import { Brand, Effect, Result, Schema, SchemaIssue, SchemaTransformation } from 'effect'
import { EncodedByteSequence, SaveByteLength } from './brand-types.js'

/** Define a wire-compatible Uint8Array with an exact byte length. */
export const fixedUint8Array = (
  length: SaveByteLength,
): Schema.Codec<Uint8Array, EncodedByteSequence> => {
  const checkedLength = SaveByteLength.result(length)
  const encodedBytes = Schema.declareConstructor<EncodedByteSequence, EncodedByteSequence>()(
    [],
    () => (value, _ast, options) => {
      const snapshot = Result.try({
        try: () => {
          if (!Array.isArray(value)) {
            return { _tag: 'failure' as const, message: 'encoded byte sequence must be an array' }
          }

          const actualLength = value.length
          if (!Result.isSuccess(checkedLength) || actualLength !== checkedLength.success) {
            return {
              _tag: 'failure' as const,
              message: `Uint8Array must contain exactly ${String(length)} bytes`,
            }
          }

          const bytes: Array<number> = []
          for (let index = 0; index < actualLength; index += 1) {
            const byte: unknown = value[index]
            if (typeof byte !== 'number' || !Number.isSafeInteger(byte) || byte < 0 || byte > 255) {
              return {
                _tag: 'failure' as const,
                message: 'byte must be an integer between 0 and 255',
              }
            }
            bytes.push(byte)
          }
          return { _tag: 'success' as const, bytes }
        },
        catch: () => ({ _tag: 'failure' as const, message: 'encoded byte sequence could not be read' }),
      })

      if (Result.isFailure(snapshot)) {
        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: snapshot.failure.message }, value, options),
        )
      }
      if (snapshot.success._tag === 'failure') {
        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: snapshot.success.message }, value, options),
        )
      }
      const bytes = snapshot.success.bytes
      return Effect.succeed(Brand.nominal<EncodedByteSequence>()(bytes))
    },
  )

  return Schema.decodeTo<Schema.Uint8Array, typeof encodedBytes, never, never>(
    Schema.Uint8Array,
    SchemaTransformation.transformEffect<Uint8Array, EncodedByteSequence>({
      decode: (value) => Effect.succeed(new Uint8Array(value)),
      encode: (value, options) => {
        const bytes = Result.try({
          try: () => Array.from(value),
          catch: () => new SchemaIssue.InvalidValue({ message: 'Uint8Array could not be read' }, value, options),
        })
        if (Result.isFailure(bytes)) return Effect.fail(bytes.failure)
        if (!Result.isSuccess(checkedLength) || bytes.success.length !== checkedLength.success) {
          return Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: `Uint8Array must contain exactly ${String(length)} bytes` },
              value,
              options,
            ),
          )
        }
        const encoded = EncodedByteSequence.result(bytes.success)
        return Result.isSuccess(encoded)
          ? Effect.succeed(encoded.success)
          : Effect.fail(new SchemaIssue.InvalidValue({ message: encoded.failure.message }, value, options))
      },
    }),
  )(encodedBytes)
}
