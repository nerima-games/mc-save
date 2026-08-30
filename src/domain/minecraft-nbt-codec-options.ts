import { NbtFormatError } from './minecraft-nbt-types.js'

export type NbtCodecOptions = {
  readonly maxBytes?: number
  readonly maxDepth?: number
  readonly maxElements?: number
  readonly maxStringBytes?: number
}

export const DEFAULT_NBT_CODEC_OPTIONS = {
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
): number => {
  const resolved = value ?? DEFAULT_NBT_CODEC_OPTIONS[name]
  if (!Number.isSafeInteger(resolved) || resolved < minimum || (maximum !== undefined && resolved > maximum)) {
    const upper = maximum === undefined ? '' : ` and at most ${String(maximum)}`
    throw nbtError(`${name} must be a safe integer of at least ${String(minimum)}${upper}`)
  }
  return resolved
}

export const resolveNbtCodecOptions = (options: NbtCodecOptions | undefined): ResolvedNbtCodecOptions => ({
  maxBytes: resolveLimit('maxBytes', options?.maxBytes, 1),
  maxDepth: resolveLimit('maxDepth', options?.maxDepth, 1),
  maxElements: resolveLimit('maxElements', options?.maxElements, 0),
  maxStringBytes: resolveLimit('maxStringBytes', options?.maxStringBytes, 0, 0xffff),
})
