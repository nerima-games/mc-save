import { Data } from 'effect'
import type * as Cause from 'effect/Cause'

export type MinecraftJavaSaveOperation = 'encode' | 'decode' | 'validate'

type MinecraftJavaSaveErrorFields = {
  readonly operation: MinecraftJavaSaveOperation
  readonly reason: string
  readonly path?: string
}

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
  reason: string,
  path?: string,
): MinecraftJavaSaveError =>
  new MinecraftJavaSaveError({ operation, reason, ...(path === undefined ? {} : { path }) })

export const throwMinecraftJavaSaveError = (
  operation: MinecraftJavaSaveOperation,
  reason: string,
  path?: string,
): never => {
  throw minecraftJavaSaveError(operation, reason, path)
}

export const errorReason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
