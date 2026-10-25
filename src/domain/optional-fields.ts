/**
 * The gap between a domain field typed `T | undefined` and this package's own
 * integrity checksum, which rejects a bare `undefined` anywhere in an encoded
 * payload (`integrity-canonical.ts`'s `canonicalize` returns a failure for anything that
 * is not a string / boolean / finite-or-non-finite number / null / plain
 * object / array / `Uint8Array`).
 *
 * `undefined` and `null` are not interchangeable in most payloads, so this
 * never sweeps every `undefined` a value happens to contain — only the named
 * fields a caller has confirmed use `undefined` (never `null`) for their own
 * domain meaning. Each field a consumer swaps is a deliberate per-field
 * decision, not a blanket normalization.
 */
import { Effect, Result, Schema, SchemaIssue, SchemaTransformation } from 'effect'
import { JsonFieldName } from './brand-types.js'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null


const validateFields = (
  fields: ReadonlyArray<JsonFieldName>,
  actual: unknown,
): Result.Result<ReadonlyArray<JsonFieldName>, SchemaIssue.Issue> => {
  const captured = Result.try({
    try: () => Array.from(fields),
    catch: () => new SchemaIssue.InvalidValue({ message: 'Optional field names could not be read' }, actual),
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)

  const checkedFields: Array<JsonFieldName> = []
  for (const field of captured.success) {
    const checked = JsonFieldName.result(field)
    if (Result.isFailure(checked)) {
      return Result.fail(new SchemaIssue.InvalidValue({ message: 'Optional field names must be strings' }, actual))
    }
    checkedFields.push(checked.success)
  }
  return Result.succeed(checkedFields)
}

/**
 * Decode side: a stored `null` becomes the domain's `undefined`, for exactly
 * the named fields. A field that is absent entirely is left absent — this
 * restores a VALUE, it does not invent a key.
 */
export const restoreNullAsUndefined =
  (fields: ReadonlyArray<JsonFieldName>) =>
  (value: unknown): Result.Result<unknown, SchemaIssue.Issue> => {
    const checkedFields = validateFields(fields, value)
    if (Result.isFailure(checkedFields)) return Result.fail(checkedFields.failure)
    if (!isRecord(value)) return Result.succeed(value)
    const captured = Result.try({
      try: () => {
        const keys = new Set(Object.keys(value))
        for (const field of checkedFields.success) {
          if (!keys.has(field) && Object.getOwnPropertyDescriptor(value, field) !== undefined) keys.add(field)
        }
        return {
          hasSymbolKeys: Object.getOwnPropertySymbols(value).length > 0,
          output: Object.fromEntries([...keys].map((key) => [key, value[key]] as const)),
        }
      },
      catch: () => new SchemaIssue.InvalidValue({ message: 'Optional fields could not be read' }, value),
    })
    if (Result.isFailure(captured)) return Result.fail(captured.failure)
    if (captured.success.hasSymbolKeys) {
      return Result.fail(new SchemaIssue.InvalidValue({ message: 'Symbol-keyed fields are not supported' }, value))
    }
    const output = captured.success.output
    for (const field of checkedFields.success) {
      if (Object.hasOwn(output, field) && output[field] === null) output[field] = undefined
    }
    return Result.succeed(output)
  }

/**
 * Encode side: a present `undefined` value becomes `null`, for exactly the
 * named fields, so the payload survives `canonicalize`. A field that is
 * absent entirely is left absent.
 */
export const encodeUndefinedAsNull =
  (fields: ReadonlyArray<JsonFieldName>) =>
  (value: unknown): Result.Result<unknown, SchemaIssue.Issue> => {
    const checkedFields = validateFields(fields, value)
    if (Result.isFailure(checkedFields)) return Result.fail(checkedFields.failure)
    if (!isRecord(value)) return Result.succeed(value)
    const captured = Result.try({
      try: () => {
        const keys = new Set(Object.keys(value))
        for (const field of checkedFields.success) {
          if (!keys.has(field) && Object.getOwnPropertyDescriptor(value, field) !== undefined) keys.add(field)
        }
        return {
          hasSymbolKeys: Object.getOwnPropertySymbols(value).length > 0,
          output: Object.fromEntries([...keys].map((key) => [key, value[key]] as const)),
        }
      },
      catch: () => new SchemaIssue.InvalidValue({ message: 'Optional fields could not be read' }, value),
    })
    if (Result.isFailure(captured)) return Result.fail(captured.failure)
    if (captured.success.hasSymbolKeys) {
      return Result.fail(new SchemaIssue.InvalidValue({ message: 'Symbol-keyed fields are not supported' }, value))
    }
    const output = captured.success.output
    for (const field of checkedFields.success) {
      if (Object.hasOwn(output, field) && output[field] === undefined) output[field] = null
    }
    return Result.succeed(output)
  }

/**
 * Wrap an inner schema so its named fields round-trip through storage as
 * `null` while the decoded domain value keeps `undefined`. This is the
 * `Schema.transform(Schema.Unknown, inner, { strict: false, decode, encode })`
 * shape a format author would otherwise hand-write per field.
 */
export const undefinedFieldsAsNull = <A>(
  inner: Schema.Codec<A, unknown>,
  fields: ReadonlyArray<JsonFieldName>,
): Schema.Codec<A, unknown> =>
  Schema.decodeTo<Schema.Codec<A, unknown>, Schema.Unknown, never, never>(
    inner,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        const decoded = restoreNullAsUndefined(fields)(value)
        return Result.isFailure(decoded) ? Effect.fail(decoded.failure) : Effect.succeed(decoded.success)
      },
      encode: (value) => {
        const encoded = encodeUndefinedAsNull(fields)(value)
        return Result.isFailure(encoded) ? Effect.fail(encoded.failure) : Effect.succeed(encoded.success)
      },
    }),
  )(Schema.Unknown)
