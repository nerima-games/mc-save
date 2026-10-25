import { Effect, Fiber, Option, Result, SynchronizedRef } from 'effect'

type WriteQueueState<E> = Readonly<{
  tail: Option.Option<Fiber.Fiber<void, never>>
  lastFailure: Option.Option<E>
}>

export interface WriteQueue<E, R> {
  enqueue(write: Effect.Effect<void, E, R>): Effect.Effect<void, never, R>
  readonly drain: Effect.Effect<void, E, R>
}

export const makeWriteQueue = <E, R>(): Effect.Effect<WriteQueue<E, R>> =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<WriteQueueState<E>>({
      tail: Option.none(),
      lastFailure: Option.none()
    })

    const enqueue = (write: Effect.Effect<void, E, R>): Effect.Effect<void, never, R> =>
      SynchronizedRef.modifyEffect(state, (current) =>
        Effect.gen(function* () {
          const task = Effect.gen(function* () {
            if (Option.isSome(current.tail)) {
              yield* Fiber.join(current.tail.value)
            }

            const result = yield* Effect.result(write)
            yield* SynchronizedRef.update(state, (latest) => ({
              ...latest,
              lastFailure: Result.isFailure(result) ? Option.some(result.failure) : latest.lastFailure
            }))
          })

          const tail = yield* Effect.forkDetach(task)
          return [undefined, { ...current, tail: Option.some(tail) }] as const
        })
      )

    const drain: Effect.Effect<void, E, R> = Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(state)
      if (Option.isSome(current.tail)) {
        yield* Fiber.join(current.tail.value)
      }

      const lastFailure = yield* SynchronizedRef.modify(state, (latest) => [
        latest.lastFailure,
        { ...latest, lastFailure: Option.none<E>() },
      ] as const)
      if (Option.isSome(lastFailure)) {
        return yield* Effect.fail(lastFailure.value)
      }
    })

    return { enqueue, drain }
  })
