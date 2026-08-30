import { Effect } from 'effect'
import type { SaveEnvelope } from './envelope.js'
import { SaveDecodeError, StorageError } from './errors.js'
import type { SaveFormat } from './format.js'
import { prepareSave, type SaveWriteOptions } from './save-preparation.js'
import type { SaveKey } from './save-key.js'
import { StoragePort } from './storage-port.js'

export type SaveBatchEntry = {
  readonly key: SaveKey
  readonly prepare: Effect.Effect<SaveEnvelope, SaveDecodeError>
}

export const saveBatchEntry = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  value: NoInfer<A>,
  options?: SaveWriteOptions,
): SaveBatchEntry => ({
  key,
  prepare: prepareSave(format, value, options),
})

export const saveBatch = (
  entries: ReadonlyArray<SaveBatchEntry>,
): Effect.Effect<void, StorageError | SaveDecodeError, StoragePort> =>
  Effect.gen(function* () {
    if (entries.length === 0) return

    const storage = yield* StoragePort
    const mutations = yield* Effect.forEach(
      entries,
      (entry) =>
        entry.prepare.pipe(
          Effect.map((envelope) => ({
            _tag: 'Put' as const,
            key: entry.key,
            envelope,
          })),
        ),
      { concurrency: 1 },
    )
    yield* storage.commitBatch(mutations)
  })
