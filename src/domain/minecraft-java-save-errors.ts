import { Brand, Data, Result } from 'effect'
import type * as Cause from 'effect/Cause'
import { ValidationMessage } from './brand-types.js'

export type MinecraftJavaSaveOperation = 'encode' | 'decode' | 'validate'

type MinecraftJavaSaveErrorFields = {
  readonly operation: MinecraftJavaSaveOperation
  readonly reason: ValidationMessage
  readonly path?: MinecraftJavaSaveErrorPath
}

export type MinecraftJavaSaveErrorPath = string & Brand.Brand<'MinecraftJavaSaveErrorPath'>

const toMinecraftJavaSaveErrorPath = Brand.make<MinecraftJavaSaveErrorPath>(
  (value) => typeof value === 'string' || 'error path must be a string',
)

const MinecraftJavaSaveErrorBase: new (
  args: MinecraftJavaSaveErrorFields,
) => Cause.YieldableError & { readonly _tag: 'MinecraftJavaSaveError' } & Readonly<MinecraftJavaSaveErrorFields> =
  Data.TaggedError('MinecraftJavaSaveError')

export class MinecraftJavaSaveError extends MinecraftJavaSaveErrorBase {
  override get message(): string {
    const location = this.path === undefined ? '' : ` at ${this.path}`
    return `Minecraft Java save ${this.operation} failed${location}: ${this.reason}`
  }
}

export const minecraftJavaSaveError = (
  operation: MinecraftJavaSaveOperation,
  reason: unknown,
  path?: unknown,
): Result.Result<MinecraftJavaSaveError, TypeError> =>
  Result.gen(function* () {
    const reasonText = yield* Result.try({
      try: () => String(reason),
      catch: () => new TypeError('error reason could not be formatted'),
    })
    const brandedReason = yield* Result.mapError(
      ValidationMessage.result(reasonText),
      () => new TypeError('error reason is not a valid validation message'),
    )
    if (path === undefined) return new MinecraftJavaSaveError({ operation, reason: brandedReason })

    const pathText = yield* Result.try({
      try: () => String(path),
      catch: () => new TypeError('error path could not be formatted'),
    })
    const brandedPath = yield* Result.mapError(
      toMinecraftJavaSaveErrorPath.result(pathText),
      () => new TypeError('error path is not a valid string'),
    )
    return new MinecraftJavaSaveError({ operation, reason: brandedReason, path: brandedPath })
  })

export const errorReason = (error: unknown): Result.Result<ValidationMessage, TypeError> =>
  Result.gen(function* () {
    const message = yield* Result.try({
      try: () => error instanceof Error ? error.message : String(error),
      catch: () => new TypeError('operation error could not be formatted'),
    })
    return yield* Result.mapError(
      ValidationMessage.result(message),
      () => new TypeError('operation error is not a valid validation message'),
    )
  })
