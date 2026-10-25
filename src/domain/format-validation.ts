import { Result } from 'effect'
import { SaveFormatName, SaveFormatVersion, ValidationMessage } from './brand-types.js'

export type SaveFormatIdentity = Readonly<{
  name: SaveFormatName
  version: SaveFormatVersion
}>

export const validateFormatDefinition = (spec: {
  readonly name: unknown
  readonly version: unknown
}): Result.Result<SaveFormatIdentity, ReadonlyArray<ValidationMessage>> => {
  if (typeof spec.name !== 'string' || typeof spec.version !== 'number') {
    return Result.fail([
      ValidationMessage('format name and version have invalid types'),
    ])
  }

  const name = SaveFormatName.result(spec.name)
  const version = SaveFormatVersion.result(spec.version)
  const problems: Array<ValidationMessage> = []

  if (Result.isFailure(name)) {
    problems.push(ValidationMessage('name must be a non-blank string'))
  }
  if (Result.isFailure(version)) {
    problems.push(ValidationMessage('version must be a safe integer >= 1'))
  }

  return Result.isFailure(name) || Result.isFailure(version)
    ? Result.fail(problems)
    : Result.succeed({ name: name.success, version: version.success })
}
