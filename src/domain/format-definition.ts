import { Result, type Schema } from 'effect'
import { ValidationMessage } from './brand-types.js'
import { validateFormatDefinition } from './format-validation.js'
import type { SaveFormat } from './format-types.js'

export const defineFormat = <A, I>(spec: {
  readonly name: unknown
  readonly version: unknown
  readonly schema: Schema.Codec<A, I>
}): Result.Result<SaveFormat<A, I>, ReadonlyArray<ValidationMessage>> => {
  const captured = Result.try({
    try: () => ({ name: spec.name, version: spec.version, schema: spec.schema }),
    catch: () => [ValidationMessage('format definition fields could not be read')],
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const identity = validateFormatDefinition(captured.success)
  if (Result.isFailure(identity)) return Result.fail(identity.failure)
  return Result.succeed({ ...identity.success, schema: captured.success.schema })
}
