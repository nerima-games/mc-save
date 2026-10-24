import { Schema, SchemaGetter } from 'effect'

/** Define a wire-compatible Uint8Array with an exact byte length. */
export const fixedUint8Array = (length: number): Schema.Codec<Uint8Array, ReadonlyArray<number>> => {
  const bytes = Schema.Array(
    Schema.Number.check(
      Schema.makeFilter<number>((value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 255
          ? undefined
          : 'byte must be an integer between 0 and 255',
      ),
    ),
  ).check(
    Schema.makeFilter<ReadonlyArray<number>>((value) =>
      Number.isSafeInteger(length) && length >= 0 && value.length === length
        ? undefined
        : `Uint8Array must contain exactly ${String(length)} bytes`,
    ),
  )

  return bytes.pipe(
    Schema.decodeTo(Schema.Uint8Array, {
      decode: SchemaGetter.transform((value: ReadonlyArray<number>) => new Uint8Array(value)),
      encode: SchemaGetter.transform((value: Uint8Array) => Array.from(value)),
    }),
  )
}
