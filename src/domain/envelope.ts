/**
 * The versioned envelope: the one thing that is written to storage.
 *
 * ---------------------------------------------------------------------------
 * Why this type exists at all
 * ---------------------------------------------------------------------------
 *
 * The envelope keeps the format identity, version, payload, and integrity
 * metadata together at the storage boundary. `decodeSave` can therefore reject
 * an unknown or non-current format before the payload schema sees the data,
 * while storage adapters can validate the same boundary without knowing the
 * payload's domain type.
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
 * is known, and the payload is decoded only after the envelope's strict
 * current-version checks have completed.
 */
export type SaveIntegrity = {
  readonly algorithm: 'fnv1a32'
  readonly byteLength: number
  readonly checksum: string
}

export type SaveEnvelope = {
  readonly format: string
  readonly version: number
  readonly payload: unknown
  readonly integrity: SaveIntegrity
  /** Game-owned state unknown to mc-save, retained verbatim across checkpoints. */
  readonly extensions?: Readonly<Record<string, unknown>> | undefined
}

export type SaveEnvelopeDraft = Omit<SaveEnvelope, 'integrity'>

const safeVersionSchema = Schema.Number.pipe(
  Schema.greaterThanOrEqualTo(FIRST_VERSION),
  Schema.filter((value): value is number => Number.isSafeInteger(value), {
    message: () => 'Save envelope version must be a safe integer',
  }),
)

const safeByteLengthSchema = Schema.Number.pipe(
  Schema.greaterThanOrEqualTo(0),
  Schema.filter((value): value is number => Number.isSafeInteger(value), {
    message: () => 'Save integrity byte length must be a safe integer',
  }),
)

export const SaveEnvelopeSchema: Schema.Schema<SaveEnvelope> = Schema.Struct({
  format: Schema.String.pipe(
    Schema.minLength(1),
    Schema.filter((value): value is string => value.trim().length > 0, {
      message: () => 'Save envelope format must be a non-blank string',
    }),
  ),
  version: safeVersionSchema,
  payload: Schema.Unknown.pipe(
    Schema.filter((value): value is unknown => value !== undefined, {
      message: () => 'Save envelope payload must be present',
    }),
  ),
  integrity: Schema.Struct({
    algorithm: Schema.Literal('fnv1a32'),
    byteLength: safeByteLengthSchema,
    checksum: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{8}$/u)),
  }),
  extensions: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})

export const SaveEnvelopeDraftSchema: Schema.Schema<SaveEnvelopeDraft> = Schema.Struct({
  format: Schema.String.pipe(
    Schema.minLength(1),
    Schema.filter((value): value is string => value.trim().length > 0, {
      message: () => 'Save envelope format must be a non-blank string',
    }),
  ),
  version: safeVersionSchema,
  payload: Schema.Unknown.pipe(
    Schema.filter((value): value is unknown => value !== undefined, {
      message: () => 'Save envelope payload must be present',
    }),
  ),
  extensions: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})

export const saveEnvelope = (format: string, version: number, payload: unknown): SaveEnvelopeDraft => ({
  format,
  version,
  payload,
})

/**
 * True when the envelope was written by a build newer than this one.
 *
 * Worth its own predicate because it must not be treated as corruption. A
 * caller can present a newer save as unavailable until a compatible build is
 * installed instead of offering destructive recovery actions.
 */
export const isFromFuture = (envelope: Pick<SaveEnvelope, 'version'>, currentVersion: number): boolean =>
  envelope.version > currentVersion
