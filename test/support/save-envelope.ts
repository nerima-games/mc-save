import type { SaveEnvelope } from '../../src/domain/envelope.js'
import { saveEnvelope } from '../../src/domain/envelope.js'
import { sealSaveEnvelope } from '../../src/domain/integrity.js'

export const sealedTestEnvelope = (
  format: string,
  version: number,
  payload: unknown,
  extensions?: Readonly<Record<string, unknown>>,
): SaveEnvelope => sealSaveEnvelope(saveEnvelope(format, version, payload), extensions)

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
