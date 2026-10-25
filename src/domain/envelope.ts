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
import {
  SaveByteLength,
  SaveChecksum,
  SaveFormatName,
  SaveFormatVersion,
  type JsonFieldName as JsonFieldNameType,
  type SaveByteLength as SaveByteLengthType,
  type SaveChecksum as SaveChecksumType,
  type SaveFormatName as SaveFormatNameType,
  type SaveFormatVersion as SaveFormatVersionType,
} from './brand-types.js'

/**
 * A format version. Positive integers, counting from 1. The envelope schema
 * restores the brand after validating values read from storage.
 */
export const FIRST_VERSION: SaveFormatVersionType = SaveFormatVersion(1)

/**
 * What is actually handed to `StoragePort`.
 *
 * `payload` is `unknown` on purpose: the envelope is opened before the format
 * is known, and the payload is decoded only after the envelope's strict
 * current-version checks have completed.
 */
export type SaveIntegrity = {
  readonly algorithm: 'fnv1a32'
  readonly byteLength: SaveByteLengthType
  readonly checksum: SaveChecksumType
}

export type SaveEnvelope = {
  readonly format: SaveFormatNameType
  readonly version: SaveFormatVersionType
  readonly payload: unknown
  readonly integrity: SaveIntegrity
  /** Game-owned state unknown to mc-save, retained verbatim across checkpoints. */
  readonly extensions?: Readonly<Record<JsonFieldNameType, unknown>> | undefined
}

export type SaveEnvelopeDraft = Omit<SaveEnvelope, 'integrity'>

const safeVersionSchema: Schema.Codec<SaveFormatVersionType, number, never, never> =
  Schema.fromBrand('SaveFormatVersion', SaveFormatVersion)(Schema.Number)

const safeByteLengthSchema: Schema.Codec<SaveByteLengthType, number, never, never> =
  Schema.fromBrand('SaveByteLength', SaveByteLength)(Schema.Number)

const saveFormatNameSchema: Schema.Codec<SaveFormatNameType, string, never, never> =
  Schema.fromBrand('SaveFormatName', SaveFormatName)(Schema.String)

const saveChecksumSchema: Schema.Codec<SaveChecksumType, string, never, never> =
  Schema.fromBrand('SaveChecksum', SaveChecksum)(Schema.String)

const jsonFieldNameSchema = Schema.String.pipe(Schema.brand('JsonFieldName'))

export const SaveEnvelopeSchema: Schema.Codec<SaveEnvelope, unknown, never, never> = Schema.Struct({
  format: saveFormatNameSchema,
  version: safeVersionSchema,
  payload: Schema.Unknown.check(
    Schema.makeFilter<unknown>((value) => value !== undefined ? undefined : 'Save envelope payload must be present'),
  ),
  integrity: Schema.Struct({
    algorithm: Schema.Literal('fnv1a32'),
    byteLength: safeByteLengthSchema,
    checksum: saveChecksumSchema,
  }),
  extensions: Schema.optional(Schema.Record(jsonFieldNameSchema, Schema.Unknown)),
})

export const SaveEnvelopeDraftSchema: Schema.Codec<SaveEnvelopeDraft, unknown, never, never> = Schema.Struct({
  format: saveFormatNameSchema,
  version: safeVersionSchema,
  payload: Schema.Unknown.check(
    Schema.makeFilter<unknown>((value) => value !== undefined ? undefined : 'Save envelope payload must be present'),
  ),
  extensions: Schema.optional(Schema.Record(jsonFieldNameSchema, Schema.Unknown)),
})

export const saveEnvelope = (format: SaveFormatNameType, version: SaveFormatVersionType, payload: unknown): SaveEnvelopeDraft => ({
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
export const isFromFuture = (envelope: Pick<SaveEnvelope, 'version'>, currentVersion: SaveFormatVersionType): boolean =>
  envelope.version > currentVersion
