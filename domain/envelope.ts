/**
 * The versioned envelope: the one thing that is written to storage.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * ---------------------------------------------------------------------------
 * Why this type exists at all
 * ---------------------------------------------------------------------------
 *
 * In the reference implementation a chunk was persisted by handing the raw
 * `Uint8Array` straight to IndexedDB and letting structured clone do the rest
 * (`packages/world/infrastructure/storage-service.ts:101-106` →
 * `packages/world/infrastructure/idb-utils.ts:92-96`). Nothing was written
 * alongside it: no format name, no version, no length header. The consequences
 * were exactly what you would predict:
 *
 *  - A stored buffer of the wrong size could only be detected by comparing it
 *    against a hard-coded expected length, and the only available recovery was
 *    to throw the save away
 *    (`packages/world/application/chunk-manager-ops-storage.ts:47-50`:
 *    "has invalid buffer length ... regenerating").
 *  - `WORLD_SCHEMA_VERSION = 3` was declared twice
 *    (`storage-idb-model.ts:7` and `packages/world/domain/chunk.ts:9`) and read
 *    by nobody.
 *  - The separate `saveVersion` field on world metadata was written
 *    (`session-save-metadata.ts:40`) and read exactly once, in a log line
 *    (`session-world-loader.ts:174`). No code ever branched on it.
 *
 * So the reference had two version numbers, neither of which did anything. The
 * envelope makes the version the *outermost* thing rather than a field buried
 * inside the payload, which is what allows `decodeSave` to migrate before
 * `Schema` ever sees the data — the ordering the reference could not achieve.
 */
import { Schema } from 'effect'

/**
 * A format version. Positive integers, counting from 1.
 *
 * Deliberately not branded. The version has to survive a JSON/structured-clone
 * round trip through storage written by an older build, so it arrives as a bare
 * number and is validated by `SaveEnvelopeSchema` at the boundary. A brand would
 * imply a guarantee that the value's own provenance cannot support.
 */
export const FIRST_VERSION = 1

/**
 * What is actually handed to `StoragePort`.
 *
 * `payload` is `unknown` on purpose: the envelope is opened before the format
 * is known, and migrations operate on untyped data by nature — a migration from
 * v1 to v2 must accept a shape that no current schema describes.
 */
export type SaveEnvelope = {
  readonly format: string
  readonly version: number
  readonly payload: unknown
}

export const SaveEnvelopeSchema: Schema.Schema<SaveEnvelope> = Schema.Struct({
  format: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(FIRST_VERSION)),
  payload: Schema.Unknown,
})

export const saveEnvelope = (format: string, version: number, payload: unknown): SaveEnvelope => ({
  format,
  version,
  payload,
})

/**
 * True when the envelope was written by a build newer than this one.
 *
 * Worth its own predicate because it is the case that must NOT be treated as
 * corruption. A player who opens a save from a newer build deserves "this world
 * needs a newer version of the game", not the reference implementation's
 * `"${worldId} (corrupt)"` with a delete button as the only affordance
 * (`packages/presentation/menu/main-menu-handlers.ts:137-142`).
 */
export const isFromFuture = (envelope: SaveEnvelope, currentVersion: number): boolean =>
  envelope.version > currentVersion
