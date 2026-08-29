import type { Schema } from 'effect'
import { validateFormatDefinition } from './format-validation.js'
import type { SaveFormat } from './format-types.js'

export const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Schema<A, I>
}): SaveFormat<A, I> => {
  const problems = validateFormatDefinition({
    name: spec.name,
    version: spec.version,
  })

  if (problems.length > 0) {
    throw new Error(
      `save format "${spec.name}" is not well-formed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    )
  }

  return {
    name: spec.name,
    version: spec.version,
    schema: spec.schema,
  }
}
