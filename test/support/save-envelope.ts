import type { SaveEnvelope } from '../../src/domain/envelope.js'
import { saveEnvelope } from '../../src/domain/envelope.js'
import { sealSaveEnvelope } from '../../src/domain/integrity.js'

export const sealedTestEnvelope = (
  format: string,
  version: number,
  payload: unknown,
  extensions?: Readonly<Record<string, unknown>>,
): SaveEnvelope => sealSaveEnvelope(saveEnvelope(format, version, payload), extensions)

export const unsealedTestEnvelope = (format: string, version: number, payload: unknown): SaveEnvelope =>
  saveEnvelope(format, version, payload) as unknown as SaveEnvelope
