import { Deferred, Effect, Exit, Result } from 'effect'
import { describe, expect } from 'vitest'
import { makeWriteQueue } from '../src/application/write-queue.js'
import { effect } from './support/effect-test.js'

describe('makeWriteQueue', () => {
  effect('drains successfully when no writes have been enqueued', () =>
    Effect.gen(function* () {
      const queue = yield* makeWriteQueue<string, never>()
      const result = yield* Effect.result(queue.drain)

      expect(Result.isSuccess(result)).toBe(true)
    })
  )

  effect('propagates defects from detached writes through drain', () =>
    Effect.gen(function* () {
      const queue = yield* makeWriteQueue<string, never>()
      let laterWriteRan = false

      yield* queue.enqueue(Effect.die(new Error('write defect')))
      yield* queue.enqueue(
        Effect.sync(() => {
          laterWriteRan = true
        })
      )

      const exit = yield* Effect.exit(queue.drain)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(laterWriteRan).toBe(false)
    })
  )

  effect('starts writes without waiting and preserves their enqueue order', () =>
    Effect.gen(function* () {
      const queue = yield* makeWriteQueue<string, never>()
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const writes: Array<string> = []

      yield* queue.enqueue(
        Effect.gen(function* () {
          writes.push('first:start')
          yield* Deferred.succeed(firstStarted, undefined)
          yield* Deferred.await(releaseFirst)
          writes.push('first:end')
        })
      )
      yield* Deferred.await(firstStarted)

      yield* queue.enqueue(
        Effect.sync(() => {
          writes.push('second')
        })
      )
      expect(writes).toStrictEqual(['first:start'])

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* queue.drain
      expect(writes).toStrictEqual(['first:start', 'first:end', 'second'])
    })
  )

  effect('continues after failures and drain returns the latest failure', () =>
    Effect.gen(function* () {
      const queue = yield* makeWriteQueue<string, never>()
      const writes: Array<string> = []

      yield* queue.enqueue(Effect.fail('first failure'))
      yield* queue.enqueue(
        Effect.sync(() => {
          writes.push('continued')
        })
      )
      yield* queue.enqueue(Effect.fail('latest failure'))

      const result = yield* Effect.result(queue.drain)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBe('latest failure')
      }
      expect(writes).toStrictEqual(['continued'])
    })
  )

  effect('retains a failure across a later success until drain consumes it', () =>
    Effect.gen(function* () {
      const queue = yield* makeWriteQueue<string, never>()
      let laterWriteRan = false
      yield* queue.enqueue(Effect.fail('write failed'))
      yield* queue.enqueue(
        Effect.sync(() => {
          laterWriteRan = true
        }),
      )

      const failedDrain = yield* Effect.result(queue.drain)
      expect(Result.isFailure(failedDrain)).toBe(true)
      if (Result.isFailure(failedDrain)) expect(failedDrain.failure).toBe('write failed')
      expect(laterWriteRan).toBe(true)

      const recoveredDrain = yield* Effect.result(queue.drain)
      expect(Result.isSuccess(recoveredDrain)).toBe(true)
    })
  )

  effect('drain waits for the tail before reporting its failure', () =>
    Effect.gen(function* () {
      const queue = yield* makeWriteQueue<string, never>()
      const writeStarted = yield* Deferred.make<void>()
      const releaseWrite = yield* Deferred.make<void>()
      const drainResult = yield* Deferred.make<string | undefined>()

      yield* queue.enqueue(
        Effect.gen(function* () {
          yield* Deferred.succeed(writeStarted, undefined)
          yield* Deferred.await(releaseWrite)
          return yield* Effect.fail('pending write failed')
        })
      )
      yield* Deferred.await(writeStarted)

      yield* Effect.forkChild(
        Effect.gen(function* () {
          const result = yield* Effect.result(queue.drain)
          yield* Deferred.succeed(
            drainResult,
            Result.isFailure(result) ? result.failure : undefined
          )
        })
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(drainResult)).toBe(false)

      yield* Deferred.succeed(releaseWrite, undefined)
      expect(yield* Deferred.await(drainResult)).toBe('pending write failed')
    })
  )
})
