import { describe, expect } from 'vitest'
import { Effect, Option, Result, Schedule } from 'effect'
import { effect } from './support/effect-test.js'
import { StorageError } from '../src/domain/errors.js'
import {
  SaveKey,
  type StorageMutation,
  type StorageService,
} from '../src/domain/storage-port.js'
import { withStorageRetry } from '../src/domain/storage-retry.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

const KEY = SaveKey('retry/test')
const ENVELOPE = sealedTestEnvelope('mc-save/test/retry', 1, { value: 'ok' })

type Operation = 'get' | 'put' | 'remove' | 'commitBatch' | 'readBatch' | 'keys'

const retryPolicy = {
  schedule: Schedule.recurs(1),
  shouldRetry: (error: StorageError) => error.operation === 'retryable',
}

const allAttempts = (): Record<Operation, number> => ({
  get: 0,
  put: 0,
  remove: 0,
  commitBatch: 0,
  readBatch: 0,
  keys: 0,
})

const makeStorage = (attempts: Record<Operation, number>, errorOperation: string): StorageService => {
  const operation = <A>(name: Operation, result: A): Effect.Effect<A, StorageError> =>
    Effect.suspend(() => {
      attempts[name] += 1
      return attempts[name] === 1
        ? Effect.fail(new StorageError({ operation: errorOperation }))
        : Effect.succeed(result)
    })

  return {
    get: () => operation('get', Option.some(ENVELOPE)),
    put: () => operation('put', undefined),
    remove: () => operation('remove', undefined),
    commitBatch: (_mutations: ReadonlyArray<StorageMutation>) => operation('commitBatch', undefined),
    readBatch: (_keys: ReadonlyArray<SaveKey>) => operation('readBatch', [Option.none()]),
    keys: operation('keys', [KEY]),
  }
}

describe('withStorageRetry', () => {
  effect('applies the policy to every storage operation', () =>
    Effect.gen(function* () {
      const attempts = allAttempts()
      const storage = withStorageRetry(makeStorage(attempts, 'retryable'), retryPolicy)

      expect(yield* storage.get(KEY)).toStrictEqual(Option.some(ENVELOPE))
      yield* storage.put(KEY, ENVELOPE)
      yield* storage.remove(KEY)
      yield* storage.commitBatch([{ _tag: 'Remove', key: KEY }])
      expect(yield* storage.readBatch([KEY])).toStrictEqual([Option.none()])
      expect(yield* storage.keys).toStrictEqual([KEY])
      expect(attempts).toStrictEqual({
        get: 2,
        put: 2,
        remove: 2,
        commitBatch: 2,
        readBatch: 2,
        keys: 2,
      })
    }),
  )

  effect('leaves non-retryable errors untouched', () =>
    Effect.gen(function* () {
      const attempts = allAttempts()
      const storage = withStorageRetry(makeStorage(attempts, 'permanent'), retryPolicy)
      const result = yield* Effect.result(storage.put(KEY, ENVELOPE))

      expect(result).toStrictEqual(Result.fail(new StorageError({ operation: 'permanent' })))
      expect(attempts.put).toBe(1)
    }),
  )

  effect('returns the final retryable error after the schedule is exhausted', () =>
    Effect.gen(function* () {
      const attempts = allAttempts()
      const base = makeStorage(attempts, 'retryable')
      const storage: StorageService = {
        ...base,
        put: () =>
          Effect.suspend(() => {
            attempts.put += 1
            return Effect.fail(new StorageError({ operation: 'retryable' }))
          }),
      }
      const result = yield* Effect.result(withStorageRetry(storage, retryPolicy).put(KEY, ENVELOPE))

      expect(result).toStrictEqual(Result.fail(new StorageError({ operation: 'retryable' })))
      expect(attempts.put).toBe(2)
    }),
  )

  effect('converts synchronous adapter throws into StorageError', () =>
    Effect.gen(function* () {
      const thrown = new Error('synchronous adapter failure')
      const keysThrown = new Error('synchronous keys failure')
      const base = makeStorage(allAttempts(), 'permanent')
      const storage: StorageService = {
        ...base,
        get: () => {
          throw thrown
        },
        get keys(): StorageService['keys'] {
          throw keysThrown
        },
      }
      const retryingStorage = withStorageRetry(storage, retryPolicy)
      const result = yield* Effect.result(retryingStorage.get(KEY))
      const keysResult = yield* Effect.result(retryingStorage.keys)

      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure).toBeInstanceOf(StorageError)
        expect(result.failure.operation).toBe('get')
        expect(result.failure.key).toBe(KEY)
        expect(result.failure.cause).toBe(thrown)
      }
      expect(keysResult._tag).toBe('Failure')
      if (keysResult._tag === 'Failure') {
        expect(keysResult.failure).toBeInstanceOf(StorageError)
        expect(keysResult.failure.operation).toBe('keys')
        expect(keysResult.failure.key).toBeUndefined()
        expect(keysResult.failure.cause).toBe(keysThrown)
      }
    }),
  )
})
