import type { Schema } from 'effect'
import type { SaveFormatName, SaveFormatVersion } from './brand-types.js'

export type SaveFormat<A, I = A> = {
  readonly name: SaveFormatName
  readonly version: SaveFormatVersion
  readonly schema: Schema.Codec<A, I>
}
