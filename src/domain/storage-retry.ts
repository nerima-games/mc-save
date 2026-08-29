import { Effect, Schedule } from 'effect'
import { StorageError } from './errors.js'
import type { SaveEnvelope } from './envelope.js'
import type { SaveKey } from './save-key.js'
import type { StorageMutation, StorageService } from './storage-port.js'

/**
 * Retry policy for storage operations.
 *
 * The schedule controls how many attempts and how they are spaced. The
 * predicate keeps adapter-specific failures, such as quota errors, out of the
 * generic storage port.
 */
export type StorageRetryPolicy = {
  readonly schedule: Schedule.Schedule<unknown, StorageError>
  readonly shouldRetry: (error: StorageError) => boolean
}

/** Apply one retry policy consistently to every operation in a storage port. */
export const withStorageRetry = (
  storage: StorageService,
  policy: StorageRetryPolicy,
): StorageService => {
  const schedule = policy.schedule.pipe(Schedule.whileInput(policy.shouldRetry))
  const retry = <A>(
    operation: () => Effect.Effect<A, StorageError>,
    operationName: string,
    key?: SaveKey,
  ): Effect.Effect<A, StorageError> =>
    Effect.try({
      try: operation,
      catch: (cause) => new StorageError({ operation: operationName, ...(key === undefined ? {} : { key }), cause }),
    }).pipe(
      Effect.flatMap((effect) => effect),
      Effect.retry(schedule),
    )

  return {
    get: (key: SaveKey) => retry(() => storage.get(key), 'get', key),
    put: (key: SaveKey, envelope: SaveEnvelope) => retry(() => storage.put(key, envelope), 'put', key),
    remove: (key: SaveKey) => retry(() => storage.remove(key), 'remove', key),
    commitBatch: (mutations: ReadonlyArray<StorageMutation>) => retry(() => storage.commitBatch(mutations), 'commitBatch'),
    readBatch: (keys: ReadonlyArray<SaveKey>) => retry(() => storage.readBatch(keys), 'readBatch'),
    keys: retry(() => storage.keys, 'keys'),
  }
}
