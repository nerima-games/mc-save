import type { NbtDocument } from './minecraft-nbt-types.js'
import {
  nbtError,
  resolveNbtCodecOptions,
  type NbtCodecOptions,
} from './minecraft-nbt-codec-options.js'
import { decodeNbtBytes } from './minecraft-nbt-decoding.js'
import { encodeNbtDocument } from './minecraft-nbt-encoding.js'

export type { NbtCodecOptions } from './minecraft-nbt-codec-options.js'
export { DEFAULT_NBT_CODEC_OPTIONS } from './minecraft-nbt-codec-options.js'

export const encodeNbt = (document: NbtDocument, options?: NbtCodecOptions): Uint8Array => {
  const resolved = resolveNbtCodecOptions(options)
  return encodeNbtDocument(document, resolved)
}

export const decodeNbt = (bytes: Uint8Array, options?: NbtCodecOptions): NbtDocument => {
  const resolved = resolveNbtCodecOptions(options)
  if (!(bytes instanceof Uint8Array)) throw nbtError('input must be a Uint8Array')
  if (bytes.byteLength > resolved.maxBytes) {
    throw nbtError(`input exceeds maxBytes ${String(resolved.maxBytes)}`)
  }
  return decodeNbtBytes(bytes, resolved)
}
