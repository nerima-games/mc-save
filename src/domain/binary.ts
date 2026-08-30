import { Schema } from 'effect'

/** Define a wire-compatible Uint8Array with an exact byte length. */
export const fixedUint8Array = (length: number) => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(
      `fixed Uint8Array length must be a non-negative safe integer, received ${String(length)}`,
    )
  }

  return Schema.Uint8Array.pipe(Schema.filter((value) => value.byteLength === length))
}
