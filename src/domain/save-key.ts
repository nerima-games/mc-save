import type { WorldId } from '@nerima-games/mc-kernel'
import { Brand } from 'effect'

// TypeScript intentionally permits the public constructor and branded type to share this name.
// oxlint's no-redeclare rule does not model that type/value namespace distinction.
// oxlint-disable no-redeclare
export type SaveKey = string & Brand.Brand<'SaveKey'>

export const SaveKey = Brand.refined<SaveKey>(
  (value) => value.trim().length > 0,
  (value) => Brand.error(`SaveKey must be a non-blank string, received ${JSON.stringify(value)}`),
)
// oxlint-enable no-redeclare

const encodeSegment = (segment: string): string => encodeURIComponent(segment)

export const saveKeyForWorld = (
  worldId: WorldId,
  namespace: string,
  segments: ReadonlyArray<string> = [],
): SaveKey => SaveKey([namespace, worldId, ...segments].map(encodeSegment).join('/'))
