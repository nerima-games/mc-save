import type { Result, Schema } from 'effect'
import type { SaveFormatName, SaveFormatVersion } from './brand-types.js'

export type SaveFormatMigration = {
  readonly fromVersion: SaveFormatVersion
  readonly migrate: (payload: unknown) => Result.Result<unknown, unknown>
}

export type SaveFormat<A, I = A> = {
  readonly name: SaveFormatName
  readonly version: SaveFormatVersion
  readonly schema: Schema.Codec<A, I>
  readonly migrations?: ReadonlyArray<SaveFormatMigration>
}
