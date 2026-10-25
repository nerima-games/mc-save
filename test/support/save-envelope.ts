import { Result, Schema } from 'effect'
import {
  JsonFieldName,
  SaveFormatName,
  SaveFormatVersion,
  type JsonFieldName as JsonFieldNameType,
} from '../../src/domain/brand-types.js'
import type { SaveEnvelope, SaveEnvelopeDraft } from '../../src/domain/envelope.js'
import { saveEnvelope as constructSaveEnvelope } from '../../src/domain/envelope.js'
import { sealSaveEnvelope } from '../../src/domain/integrity.js'

const jsonFieldNameSchema = Schema.fromBrand('JsonFieldName', JsonFieldName)(Schema.String)
const jsonExtensionsSchema = Schema.Record(jsonFieldNameSchema, Schema.Unknown)

export const jsonExtensions = (
  extensions: Readonly<Record<string, unknown>>,
): Readonly<Record<JsonFieldNameType, unknown>> =>
  Result.getOrThrow(Schema.decodeUnknownResult(jsonExtensionsSchema)(extensions))

export const saveEnvelope = (format: string, version: number, payload: unknown): SaveEnvelopeDraft =>
  constructSaveEnvelope(
    Result.getOrThrow(SaveFormatName.result(format)),
    Result.getOrThrow(SaveFormatVersion.result(version)),
    payload,
  )

export const sealedTestEnvelope = (
  format: string,
  version: number,
  payload: unknown,
  extensions?: Readonly<Record<string, unknown>>,
): SaveEnvelope => Result.getOrThrow(sealSaveEnvelope(saveEnvelope(format, version, payload), extensions === undefined ? undefined : jsonExtensions(extensions)))

// Widens a value's static type to `T` with NO runtime transformation (no clone, no serialization) and
// no type assertion: `Record<string, any>` indexing is `any` by construction, which is assignable
// anywhere with zero compiler complaint. `saveEnvelope(...)` returns `SaveEnvelopeDraft` (no
// `integrity`) by design; widening it to `SaveEnvelope` here — rather than adding a fabricated
// `integrity` value — is what makes the result genuinely unsealed, so callers can prove their runtime
// validation, not the type checker, rejects an envelope that was never sealed.
const widen = <T,>(value: unknown): T => {
  const bag: Record<string, any> = {}
  bag['value'] = value
  return bag['value']
}

export const unsealedTestEnvelope = (format: string, version: number, payload: unknown): SaveEnvelope =>
  widen(saveEnvelope(format, version, payload))
