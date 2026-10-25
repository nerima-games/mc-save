import { Effect, Option } from 'effect'

export type RevisionEntry<Key, Value> = {
  readonly key: Key
  readonly value: Value
}

export type RevisionStorage<Key, Value, Error, Requirements> = {
  readonly get: (key: Key) => Effect.Effect<Option.Option<Value>, Error, Requirements>
  readonly put: (key: Key, value: Value) => Effect.Effect<void, Error, Requirements>
  readonly remove: (key: Key) => Effect.Effect<void, Error, Requirements>
}

export type RevisionedSave<Key, Value, Error, Requirements> = {
  readonly storage: RevisionStorage<Key, Value, Error, Requirements>
  readonly head: RevisionEntry<Key, Value>
  readonly chunks: ReadonlyArray<RevisionEntry<Key, Value>>
  readonly chunkKeysFromHead: (
    previousHead: Option.Option<Value>,
  ) => Effect.Effect<ReadonlyArray<Key>, Error, Requirements>
  readonly sameKey: (left: Key, right: Key) => boolean
  readonly duplicateKeyError: (key: Key) => Error
}

/** Write chunks first, publish the head last, and keep the previous revision on failure. */
export const writeRevisionedSave = <Key, Value, Error, Requirements>(
  input: RevisionedSave<Key, Value, Error, Requirements>,
): Effect.Effect<void, Error, Requirements> =>
  Effect.gen(function* () {
    const targetKeys: Array<Key> = [input.head.key]
    for (const chunk of input.chunks) {
      if (targetKeys.some((key) => input.sameKey(key, chunk.key))) {
        return yield* Effect.fail(input.duplicateKeyError(chunk.key))
      }
      targetKeys.push(chunk.key)
    }

    const previousHead = yield* input.storage.get(input.head.key)
    const previousChunks = yield* Effect.forEach(
      input.chunks,
      (chunk) => input.storage.get(chunk.key).pipe(Effect.map((value) => ({ key: chunk.key, value }))),
      { concurrency: 1 },
    )
    const previousChunkKeys = yield* input.chunkKeysFromHead(previousHead)

    const publish = Effect.forEach(
      input.chunks,
      (chunk) => input.storage.put(chunk.key, chunk.value),
      { concurrency: 1, discard: true },
    ).pipe(Effect.andThen(input.storage.put(input.head.key, input.head.value)))

    const result = yield* Effect.result(publish)
    if (result._tag === 'Failure') {
      const snapshots = [{ key: input.head.key, value: previousHead }, ...previousChunks]
      yield* Effect.forEach(
        snapshots,
        (snapshot) =>
          Effect.exit(
            Option.isSome(snapshot.value)
              ? input.storage.put(snapshot.key, snapshot.value.value)
              : input.storage.remove(snapshot.key),
          ),
        { concurrency: 1, discard: true },
      )
      return yield* Effect.fail(result.failure)
    }

    const obsoleteKeys = previousChunkKeys.filter(
      (key) =>
        !input.sameKey(key, input.head.key) &&
        !input.chunks.some((chunk) => input.sameKey(key, chunk.key)),
    )
    yield* Effect.forEach(
      obsoleteKeys,
      (key) => Effect.exit(input.storage.remove(key)),
      { concurrency: 1, discard: true },
    )
  })
