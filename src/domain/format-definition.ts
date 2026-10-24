import { Result, type Schema } from 'effect'
import { validateFormatDefinition } from './format-validation.js'
import type { SaveFormat } from './format-types.js'

export const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<A, I>
}): Result.Result<SaveFormat<A, I>, ReadonlyArray<string>> => {
  const captured = Result.try({
    try: () => ({ name: spec.name, version: spec.version, schema: spec.schema }),
    catch: () => ['format definition fields could not be read'],
  })
  if (Result.isFailure(captured)) return Result.fail(captured.failure)
  const { name, version, schema } = captured.success
  if (typeof name !== 'string' || typeof version !== 'number') {
    return Result.fail(['format name and version have invalid types'])
  }
  const problems = validateFormatDefinition({ name, version })
  return problems.length > 0
    ? Result.fail(problems)
    : Result.succeed({ name, version, schema })
}
