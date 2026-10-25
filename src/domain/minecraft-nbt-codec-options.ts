import { Brand, Result } from 'effect'
import { NbtFormatError } from './minecraft-nbt-types.js'

export type NbtByteLimit = number & Brand.Brand<'NbtByteLimit'>
export type NbtDepthLimit = number & Brand.Brand<'NbtDepthLimit'>
export type NbtElementLimit = number & Brand.Brand<'NbtElementLimit'>
export type NbtStringByteLimit = number & Brand.Brand<'NbtStringByteLimit'>

export type NbtCodecOptions = {
  readonly maxBytes?: unknown
  readonly maxDepth?: unknown
  readonly maxElements?: unknown
  readonly maxStringBytes?: unknown
}

export type ResolvedNbtCodecOptions = {
  readonly maxBytes: NbtByteLimit
  readonly maxDepth: NbtDepthLimit
  readonly maxElements: NbtElementLimit
  readonly maxStringBytes: NbtStringByteLimit
}

export const DEFAULT_NBT_CODEC_OPTIONS: ResolvedNbtCodecOptions = {
  maxBytes: Brand.nominal<NbtByteLimit>()(64 * 1024 * 1024),
  maxDepth: Brand.nominal<NbtDepthLimit>()(512),
  maxElements: Brand.nominal<NbtElementLimit>()(1_000_000),
  maxStringBytes: Brand.nominal<NbtStringByteLimit>()(0xffff),
}

export const nbtError = (reason: unknown, offset?: unknown): NbtFormatError => {
  const message = typeof reason === 'string' ? reason : String(reason)
  const byteOffset = typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined
  return new NbtFormatError({ reason: message, ...(byteOffset === undefined ? {} : { offset: byteOffset }) })
}

const resolveLimit = <Limit extends number>(
  name: keyof typeof DEFAULT_NBT_CODEC_OPTIONS,
  value: unknown,
  minimum: number,
  maximum: number | undefined,
  make: (value: number) => Limit,
): Result.Result<Limit, NbtFormatError> => {
  const resolved = value === undefined ? DEFAULT_NBT_CODEC_OPTIONS[name] : value
  if (
    typeof resolved !== 'number' ||
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    (maximum !== undefined && resolved > maximum)
  ) {
    const upper = maximum === undefined ? '' : ` and at most ${String(maximum)}`
    return Result.fail(
      nbtError(`${name} must be a safe integer of at least ${String(minimum)}${upper}`),
    )
  }
  return Result.succeed(make(resolved))
}

export const resolveNbtCodecOptions = (
  options: unknown,
): Result.Result<ResolvedNbtCodecOptions, NbtFormatError> =>
  Result.gen(function* () {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Result.fail(nbtError('NBT codec options must be readable'))
    }
    const values = yield* Result.try({
      try: () => options === undefined
        ? {}
        : {
            maxBytes: Reflect.get(options, 'maxBytes'),
            maxDepth: Reflect.get(options, 'maxDepth'),
            maxElements: Reflect.get(options, 'maxElements'),
            maxStringBytes: Reflect.get(options, 'maxStringBytes'),
          },
      catch: () => nbtError('NBT codec options must be readable'),
    })
    return {
      maxBytes: yield* resolveLimit('maxBytes', values.maxBytes, 1, undefined, (value) => Brand.nominal<NbtByteLimit>()(value)),
      maxDepth: yield* resolveLimit('maxDepth', values.maxDepth, 1, undefined, (value) => Brand.nominal<NbtDepthLimit>()(value)),
      maxElements: yield* resolveLimit('maxElements', values.maxElements, 0, undefined, (value) => Brand.nominal<NbtElementLimit>()(value)),
      maxStringBytes: yield* resolveLimit('maxStringBytes', values.maxStringBytes, 0, 0xffff, (value) => Brand.nominal<NbtStringByteLimit>()(value)),
    }
  })
