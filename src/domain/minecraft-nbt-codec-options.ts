import { Result } from 'effect'
import { NbtFormatError } from './minecraft-nbt-types.js'

export type NbtCodecOptions = {
  readonly maxBytes?: number
  readonly maxDepth?: number
  readonly maxElements?: number
  readonly maxStringBytes?: number
}

export const DEFAULT_NBT_CODEC_OPTIONS: {
  readonly maxBytes: number
  readonly maxDepth: 512
  readonly maxElements: 1000000
  readonly maxStringBytes: 65535
} = {
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 512,
  maxElements: 1_000_000,
  maxStringBytes: 0xffff,
} as const satisfies Required<NbtCodecOptions>

export type ResolvedNbtCodecOptions = Required<NbtCodecOptions>

export const nbtError = (reason: string, offset?: number): NbtFormatError =>
  new NbtFormatError({ reason, ...(offset === undefined ? {} : { offset }) })

const resolveLimit = (
  name: keyof typeof DEFAULT_NBT_CODEC_OPTIONS,
  value: number | undefined,
  minimum: number,
  maximum?: number,
): Result.Result<number, NbtFormatError> => {
  const resolved = value ?? DEFAULT_NBT_CODEC_OPTIONS[name]
  if (!Number.isSafeInteger(resolved) || resolved < minimum || (maximum !== undefined && resolved > maximum)) {
    const upper = maximum === undefined ? '' : ` and at most ${String(maximum)}`
    return Result.fail(
      nbtError(`${name} must be a safe integer of at least ${String(minimum)}${upper}`),
    )
  }
  return Result.succeed(resolved)
}

export const resolveNbtCodecOptions = (
  options: NbtCodecOptions | undefined,
): Result.Result<ResolvedNbtCodecOptions, NbtFormatError> =>
  Result.gen(function* () {
    const values = yield* Result.try({
      try: () => ({
        maxBytes: options?.maxBytes,
        maxDepth: options?.maxDepth,
        maxElements: options?.maxElements,
        maxStringBytes: options?.maxStringBytes,
      }),
      catch: () => nbtError('NBT codec options must be readable'),
    })
    return {
      maxBytes: yield* resolveLimit('maxBytes', values.maxBytes, 1),
      maxDepth: yield* resolveLimit('maxDepth', values.maxDepth, 1),
      maxElements: yield* resolveLimit('maxElements', values.maxElements, 0),
      maxStringBytes: yield* resolveLimit('maxStringBytes', values.maxStringBytes, 0, 0xffff),
    }
  })
