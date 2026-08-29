import { Schema } from 'effect'
import { SaveEnvelopeSchema, type SaveEnvelope } from './envelope.js'
import { INSERTION_INDEX_NAME, SAVE_STORE_NAME } from './indexeddb-layout.js'
import { SaveKey } from './save-key.js'

export const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : undefined

export const readSequence = (source: unknown, field: string): number | undefined => {
  const value = asRecord(source)?.[field]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const decodeSaveEnvelope = Schema.decodeUnknownSync(SaveEnvelopeSchema, {
  onExcessProperty: 'error',
})

export const readEnvelope = (record: unknown): SaveEnvelope | undefined => {
  const fields = asRecord(record)
  if (fields === undefined || typeof fields['key'] !== 'string') {
    return undefined
  }
  const envelope = fields['envelope']
  if (envelope === undefined) {
    return undefined
  }
  return decodeSaveEnvelope(envelope)
}

export const readKeys = (result: unknown): ReadonlyArray<SaveKey> => {
  if (!Array.isArray(result)) {
    throw new TypeError(`${INSERTION_INDEX_NAME} returned ${typeof result}, not a list of keys`)
  }
  return result.map((entry: unknown) => {
    if (typeof entry !== 'string') {
      throw new TypeError(`${SAVE_STORE_NAME} holds a record keyed by ${typeof entry}, not a string`)
    }
    return SaveKey(entry)
  })
}
