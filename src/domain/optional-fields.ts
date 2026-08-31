/**
 * The gap between a domain field typed `T | undefined` and this package's own
 * integrity checksum, which rejects a bare `undefined` anywhere in an encoded
 * payload (`integrity-canonical.ts`'s `canonicalize` throws for anything that
 * is not a string / boolean / finite-or-non-finite number / null / plain
 * object / array / `Uint8Array`).
 *
 * `undefined` and `null` are not interchangeable in most payloads, so this
 * never sweeps every `undefined` a value happens to contain — only the named
 * fields a caller has confirmed use `undefined` (never `null`) for their own
 * domain meaning. Each field a consumer swaps is a deliberate per-field
 * decision, not a blanket normalization.
 */
import { Schema } from 'effect'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

/**
 * Decode side: a stored `null` becomes the domain's `undefined`, for exactly
 * the named fields. A field that is absent entirely is left absent — this
 * restores a VALUE, it does not invent a key.
 */
export const restoreNullAsUndefined =
  (fields: ReadonlyArray<string>) =>
  (value: unknown): unknown => {
    if (!isRecord(value)) return value
    const patch: Record<string, unknown> = {}
    for (const field of fields) {
      if (Object.hasOwn(value, field) && value[field] === null) patch[field] = undefined
    }
    return Object.keys(patch).length === 0 ? value : { ...value, ...patch }
  }

/**
 * Encode side: a present `undefined` value becomes `null`, for exactly the
 * named fields, so the payload survives `canonicalize`. A field that is
 * absent entirely is left absent.
 */
export const encodeUndefinedAsNull =
  (fields: ReadonlyArray<string>) =>
  (value: unknown): unknown => {
    if (!isRecord(value)) return value
    const patch: Record<string, unknown> = {}
    for (const field of fields) {
      if (Object.hasOwn(value, field) && value[field] === undefined) patch[field] = null
    }
    return Object.keys(patch).length === 0 ? value : { ...value, ...patch }
  }

/**
 * Wrap an inner schema so its named fields round-trip through storage as
 * `null` while the decoded domain value keeps `undefined`. This is the
 * `Schema.transform(Schema.Unknown, inner, { strict: false, decode, encode })`
 * shape a format author would otherwise hand-write per field.
 */
export const undefinedFieldsAsNull = <A, I>(
  inner: Schema.Schema<A, I>,
  fields: ReadonlyArray<string>,
): Schema.Schema<A, unknown> =>
  Schema.transform(Schema.Unknown, inner, {
    strict: false,
    decode: restoreNullAsUndefined(fields),
    encode: encodeUndefinedAsNull(fields),
  })
