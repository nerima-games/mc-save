import { Result } from 'effect'
import type { NbtDocument, NbtFormatError } from './minecraft-nbt-types.js'
import {
  nbtError,
  resolveNbtCodecOptions,
  type NbtCodecOptions,
} from './minecraft-nbt-codec-options.js'
import { decodeNbtBytes } from './minecraft-nbt-decoding.js'
import { encodeNbtDocument } from './minecraft-nbt-encoding.js'

export type { NbtCodecOptions } from './minecraft-nbt-codec-options.js'
export { DEFAULT_NBT_CODEC_OPTIONS } from './minecraft-nbt-codec-options.js'

export const encodeNbt = (document: NbtDocument, options?: NbtCodecOptions): Result.Result<Uint8Array, NbtFormatError> =>
  Result.gen(function* () {
    const resolved = yield* resolveNbtCodecOptions(options)
    return yield* encodeNbtDocument(document, resolved)
  })

export const decodeNbt = (bytes: Uint8Array, options?: NbtCodecOptions): Result.Result<NbtDocument, NbtFormatError> =>
  Result.gen(function* () {
    const resolved = yield* resolveNbtCodecOptions(options)
    if (!(bytes instanceof Uint8Array)) return yield* Result.fail(nbtError('input must be a Uint8Array'))
    const snapshot = yield* Result.try({
      try: () => bytes.slice(),
      catch: () => nbtError('input could not be copied'),
    })
    if (snapshot.byteLength > resolved.maxBytes) {
      return yield* Result.fail(nbtError(`input exceeds maxBytes ${String(resolved.maxBytes)}`))
    }
    return yield* decodeNbtBytes(snapshot, resolved)
  })
