import { Effect } from 'effect'
import { it } from 'vitest'

export const effect = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, never>,
  timeout?: number,
): void => {
  it(name, () => Effect.runPromise(body()), timeout)
}
