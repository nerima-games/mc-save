import { FIRST_VERSION } from './envelope.js'

export const validateFormatDefinition = (spec: {
  readonly name: string
  readonly version: number
}): ReadonlyArray<string> => {
  const problems: Array<string> = []

  if (!Number.isSafeInteger(spec.version) || spec.version < FIRST_VERSION) {
    problems.push(
      `version must be a safe integer >= ${FIRST_VERSION}, received ${spec.version}`,
    )
    return problems
  }

  if (spec.name.trim().length === 0) {
    problems.push('name must be a non-blank string')
  }

  return problems
}
