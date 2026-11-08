import { Effect, Option } from 'effect'
import { SaveDecodeError } from '../domain/errors.js'
import type { SaveKey } from '../domain/save-key.js'

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

export type RevisionCheckpoint<Key, Value, Error, Requirements> = {
  /** The checkpoint head is the commit marker and is written after its chunks. */
  readonly headKey: Key
  /** Return a key in a revision-specific namespace, derived from the head. */
  readonly chunkKey: (head: Value, chunkKey: Key) => Key
  /** Return None when an older checkpoint cannot be inspected for cleanup. */
  readonly chunkKeysFromHead: (
    head: Value,
  ) => Effect.Effect<Option.Option<ReadonlyArray<Key>>, Error, Requirements>
  /** A failed or incomplete revision returns false; storage failures remain errors. */
  readonly isHealthy: (
    head: Value,
    chunks: ReadonlyArray<RevisionEntry<Key, Value>>,
  ) => Effect.Effect<boolean, Error, Requirements>
}

export type RevisionedSaveWithCheckpoint<Key, Value, Error, Requirements> =
  RevisionedSave<Key, Value, Error, Requirements> & {
    readonly checkpoint: RevisionCheckpoint<Key, Value, Error, Requirements>
  }

const targetKeysOf = <Key, Value, Error, Requirements>(
  input: RevisionedSave<Key, Value, Error, Requirements>,
): Effect.Effect<ReadonlyArray<Key>, Error> => {
  const keys: Array<Key> = [input.head.key]
  for (const chunk of input.chunks) {
    if (keys.some((key) => input.sameKey(key, chunk.key))) {
      return Effect.fail(input.duplicateKeyError(chunk.key))
    }
    keys.push(chunk.key)
  }
  return Effect.succeed(keys)
}

const readValues = <Key, Value, Error, Requirements>(
  storage: RevisionStorage<Key, Value, Error, Requirements>,
  keys: ReadonlyArray<Key>,
): Effect.Effect<ReadonlyArray<RevisionEntry<Key, Option.Option<Value>>>, Error, Requirements> =>
  Effect.forEach(
    keys,
    (key) => storage.get(key).pipe(Effect.map((value) => ({ key, value }))),
    { concurrency: 1 },
  )

const restoreValues = <Key, Value, Error, Requirements>(
  storage: RevisionStorage<Key, Value, Error, Requirements>,
  snapshots: ReadonlyArray<RevisionEntry<Key, Option.Option<Value>>>,
): Effect.Effect<void, never, Requirements> =>
  Effect.forEach(
    snapshots,
    ({ key, value }) =>
      Effect.exit(
        Option.isSome(value) ? storage.put(key, value.value) : storage.remove(key),
      ),
    { concurrency: 1, discard: true },
  )

const removeBestEffort = <Key, Value, Error, Requirements>(
  storage: RevisionStorage<Key, Value, Error, Requirements>,
  keys: ReadonlyArray<Key>,
): Effect.Effect<void, never, Requirements> =>
  Effect.forEach(keys, (key) => Effect.exit(storage.remove(key)), {
    concurrency: 1,
    discard: true,
  })

const obsoleteKeysOf = <Key, Value, Error, Requirements>(
  input: RevisionedSave<Key, Value, Error, Requirements>,
  previousKeys: ReadonlyArray<Key>,
): ReadonlyArray<Key> =>
  previousKeys.filter(
    (key) =>
      !input.sameKey(key, input.head.key) &&
      !input.chunks.some((chunk) => input.sameKey(key, chunk.key)),
  )

const publishLiveRevision = <Key, Value, Error, Requirements>(
  input: RevisionedSave<Key, Value, Error, Requirements>,
  previousHead: Option.Option<Value>,
  previousTargetChunks: ReadonlyArray<RevisionEntry<Key, Option.Option<Value>>>,
): Effect.Effect<void, Error, Requirements> => {
  const publish = Effect.forEach(
    input.chunks,
    (chunk) => input.storage.put(chunk.key, chunk.value),
    { concurrency: 1, discard: true },
  ).pipe(Effect.andThen(input.storage.put(input.head.key, input.head.value)))

  return Effect.gen(function* () {
    const result = yield* Effect.result(publish)
    if (result._tag === 'Failure') {
      yield* restoreValues(input.storage, [
        { key: input.head.key, value: previousHead },
        ...previousTargetChunks,
      ])
      return yield* Effect.fail(result.failure)
    }
  })
}

/** Write chunks first, publish the head last, and keep the previous revision on failure. */
export const writeRevisionedSave = <Key, Value, Error, Requirements>(
  input: RevisionedSave<Key, Value, Error, Requirements>,
): Effect.Effect<void, Error, Requirements> =>
  Effect.gen(function* () {
    yield* targetKeysOf(input)
    const previousHead = yield* input.storage.get(input.head.key)
    const previousTargetChunks = yield* readValues(
      input.storage,
      input.chunks.map(({ key }) => key),
    )
    const previousChunkKeys = yield* input.chunkKeysFromHead(previousHead)
    yield* publishLiveRevision(input, previousHead, previousTargetChunks)

    yield* removeBestEffort(input.storage, obsoleteKeysOf(input, previousChunkKeys))
  })

const hasKey = <Key>(
  keys: ReadonlyArray<Key>,
  key: Key,
  sameKey: (left: Key, right: Key) => boolean,
): boolean => keys.some((candidate) => sameKey(candidate, key))

const checkpointKeysOf = <Key, Value, Error, Requirements>(
  checkpoint: RevisionCheckpoint<Key, Value, Error, Requirements>,
  head: Value,
  chunkKeys: ReadonlyArray<Key>,
): ReadonlyArray<Key> => chunkKeys.map((key) => checkpoint.chunkKey(head, key))

const readCheckpointChunkKeys = <Key, Value, Error, Requirements>(
  input: RevisionedSaveWithCheckpoint<Key, Value, Error, Requirements>,
  head: Option.Option<Value>,
): Effect.Effect<ReadonlyArray<Key>, Error, Requirements> => {
  if (Option.isNone(head)) return Effect.succeed([])
  return input.checkpoint.chunkKeysFromHead(head.value).pipe(
    Effect.map((keys) =>
      Option.isSome(keys) ? checkpointKeysOf(input.checkpoint, head.value, keys.value) : [],
    ),
  )
}

const validateCheckpointKeys = <Key, Value, Error, Requirements>(
  input: RevisionedSaveWithCheckpoint<Key, Value, Error, Requirements>,
  liveKeys: ReadonlyArray<Key>,
  newKeys: ReadonlyArray<Key>,
  oldKeys: ReadonlyArray<Key>,
): Effect.Effect<void, Error> => {
  const marker = input.checkpoint.headKey
  if (hasKey(liveKeys, marker, input.sameKey)) {
    return Effect.fail(input.duplicateKeyError(marker))
  }

  const seen: Array<Key> = []
  for (const key of newKeys) {
    if (
      hasKey(liveKeys, key, input.sameKey) ||
      input.sameKey(marker, key) ||
      hasKey(seen, key, input.sameKey) ||
      hasKey(oldKeys, key, input.sameKey)
    ) {
      return Effect.fail(input.duplicateKeyError(key))
    }
    seen.push(key)
  }
  return Effect.void
}

const writeCheckpoint = <Key, Value, Error, Requirements>(
  input: RevisionedSaveWithCheckpoint<Key, Value, Error, Requirements>,
  head: Value,
  previousCheckpointHead: Option.Option<Value>,
  chunks: ReadonlyArray<RevisionEntry<Key, Value>>,
): Effect.Effect<void, Error, Requirements> =>
  Effect.gen(function* () {
    const copied = yield* Effect.result(
      Effect.forEach(chunks, (entry) => input.storage.put(entry.key, entry.value), {
        concurrency: 1,
        discard: true,
      }),
    )
    if (copied._tag === 'Failure') {
      yield* removeBestEffort(input.storage, chunks.map(({ key }) => key))
      return yield* Effect.fail(copied.failure)
    }

    const published = yield* Effect.result(input.storage.put(input.checkpoint.headKey, head))
    if (published._tag === 'Failure') {
      const restored = yield* Effect.result(
        Option.isSome(previousCheckpointHead)
          ? input.storage.put(input.checkpoint.headKey, previousCheckpointHead.value)
          : input.storage.remove(input.checkpoint.headKey),
      )
      if (restored._tag === 'Success') {
        yield* removeBestEffort(input.storage, chunks.map(({ key }) => key))
      }
      return yield* Effect.fail(published.failure)
    }
  })

/**
 * Retain the validated previous revision before publishing a replacement.
 * Checkpoint chunks use revision-specific keys and the checkpoint head is the
 * marker, so an interrupted copy cannot replace the last readable checkpoint.
 */
export const writeRevisionedSaveWithCheckpoint = <Key, Value, Error, Requirements>(
  input: RevisionedSaveWithCheckpoint<Key, Value, Error, Requirements>,
): Effect.Effect<void, Error, Requirements> =>
  Effect.gen(function* () {
    const liveKeys = yield* targetKeysOf(input)
    const previousHead = yield* input.storage.get(input.head.key)
    const previousTargetChunks = yield* readValues(
      input.storage,
      input.chunks.map(({ key }) => key),
    )
    const previousChunkKeys = yield* input.chunkKeysFromHead(previousHead)
    const previousRevisionChunks = yield* readValues(input.storage, previousChunkKeys)
    const previousRevisionComplete = previousRevisionChunks.every(({ value }) => Option.isSome(value))
    const previousRevisionValues = previousRevisionChunks.flatMap(({ key, value }) =>
      Option.isSome(value) ? [{ key, value: value.value }] : [],
    )

    let oldCheckpointChunkKeys: ReadonlyArray<Key> = []
    let checkpointUpdated = false
    let previousRevisionValidated = false

    if (Option.isSome(previousHead) && previousRevisionComplete) {
      const healthy = yield* input.checkpoint.isHealthy(previousHead.value, previousRevisionValues)
      if (healthy) {
        previousRevisionValidated = true
        const oldCheckpointHead = yield* input.storage.get(input.checkpoint.headKey)
        oldCheckpointChunkKeys = yield* readCheckpointChunkKeys(input, oldCheckpointHead)
        const newCheckpointChunks = previousRevisionValues.map((chunk) => ({
          key: input.checkpoint.chunkKey(previousHead.value, chunk.key),
          value: chunk.value,
        }))
        const newCheckpointChunkKeys = newCheckpointChunks.map(({ key }) => key)
        yield* validateCheckpointKeys(
          input,
          [...liveKeys, ...previousChunkKeys],
          newCheckpointChunkKeys,
          oldCheckpointChunkKeys,
        )
        yield* writeCheckpoint(
          input,
          previousHead.value,
          oldCheckpointHead,
          newCheckpointChunks,
        )
        checkpointUpdated = true
      }
    }

    yield* publishLiveRevision(input, previousHead, previousTargetChunks)
    if (previousRevisionValidated) {
      yield* removeBestEffort(
        input.storage,
        obsoleteKeysOf(input, previousChunkKeys).filter(
          (key) =>
            !input.sameKey(key, input.checkpoint.headKey) &&
            !hasKey(oldCheckpointChunkKeys, key, input.sameKey),
        ),
      )
    }

    if (checkpointUpdated) {
      yield* removeBestEffort(
        input.storage,
        oldCheckpointChunkKeys.filter(
          (key) =>
            !input.sameKey(key, input.checkpoint.headKey) &&
            !hasKey(liveKeys, key, input.sameKey) &&
            !hasKey(previousChunkKeys, key, input.sameKey),
        ),
      )
    }
  })

export type RetainedRevision<Key, Head, Chunk> = {
  readonly head: Head
  readonly chunks: ReadonlyArray<RevisionEntry<Key, Chunk>>
  readonly failures: ReadonlyArray<SaveDecodeError>
}

export type RevisionedSaveReader<Key, Raw, Head, Chunk, Error, Requirements> = {
  readonly storage: RevisionStorage<Key, Raw, Error, Requirements>
  readonly headKey: Key
  readonly chunkKey: (rawHead: Raw, chunkKey: Key) => Key
  readonly lastHealthyRevisionAvailable: boolean
  readonly decodeHead: (rawHead: Raw) => Effect.Effect<Head, SaveDecodeError, Requirements>
  readonly chunkKeysFromHead: (head: Head) => Effect.Effect<ReadonlyArray<Key>, SaveDecodeError, Requirements>
  /**
   * The caller owns chunk decoding and integrity checks. This reader does not
   * inspect or checksum raw chunk bytes, so accepted byte changes are returned.
   */
  readonly decodeChunk: (rawChunk: Raw) => Effect.Effect<Chunk, SaveDecodeError, Requirements>
  readonly missingChunkError: (head: Head, key: Key) => SaveDecodeError
  readonly keyToString: (key: Key) => SaveKey
}

const annotateDecodeError = (
  error: SaveDecodeError,
  record:
    | { readonly _tag: 'Head'; readonly key: SaveKey }
    | { readonly _tag: 'Chunk'; readonly key: SaveKey },
  lastHealthyRevisionAvailable: boolean,
): SaveDecodeError =>
  new SaveDecodeError({
    format: error.format,
    version: error.version,
    reason: error.reason,
    record,
    repair: {
      lastHealthyRevisionAvailable,
      discardableChunkKeys: record._tag === 'Chunk' ? [record.key] : [],
    },
  })

/** Read a live or retained revision while isolating corrupt chunks for partial opening. */
export const readRevisionedSave = <Key, Raw, Head, Chunk, Error, Requirements>(
  input: RevisionedSaveReader<Key, Raw, Head, Chunk, Error, Requirements>,
): Effect.Effect<Option.Option<RetainedRevision<Key, Head, Chunk>>, Error | SaveDecodeError, Requirements> =>
  Effect.gen(function* () {
    const storedHead = yield* input.storage.get(input.headKey)
    if (Option.isNone(storedHead)) return Option.none()

    const decodedHead = yield* input.decodeHead(storedHead.value).pipe(
      Effect.mapError((error) =>
        annotateDecodeError(
          error,
          { _tag: 'Head', key: input.keyToString(input.headKey) },
          input.lastHealthyRevisionAvailable,
        ),
      ),
    )
    const chunkKeys = yield* input.chunkKeysFromHead(decodedHead).pipe(
      Effect.mapError((error) =>
        annotateDecodeError(
          error,
          { _tag: 'Head', key: input.keyToString(input.headKey) },
          input.lastHealthyRevisionAvailable,
        ),
      ),
    )
    const chunks: Array<RevisionEntry<Key, Chunk>> = []
    const failures: Array<SaveDecodeError> = []

    yield* Effect.forEach(
      chunkKeys,
      (key) =>
        Effect.gen(function* () {
          const revisionChunkKey = input.chunkKey(storedHead.value, key)
          const revisionChunkKeyString = input.keyToString(revisionChunkKey)
          const storedChunk = yield* input.storage.get(revisionChunkKey)
          if (Option.isNone(storedChunk)) {
            failures.push(
              annotateDecodeError(
                input.missingChunkError(decodedHead, key),
                { _tag: 'Chunk', key: revisionChunkKeyString },
                input.lastHealthyRevisionAvailable,
              ),
            )
            return
          }

          const decodedChunk = yield* Effect.result(input.decodeChunk(storedChunk.value))
          if (decodedChunk._tag === 'Failure') {
            failures.push(
              annotateDecodeError(
                decodedChunk.failure,
                { _tag: 'Chunk', key: revisionChunkKeyString },
                input.lastHealthyRevisionAvailable,
              ),
            )
            return
          }
          chunks.push({ key, value: decodedChunk.success })
        }),
      { concurrency: 1, discard: true },
    )

    return Option.some({ head: decodedHead, chunks, failures })
  })

/** Load a retained revision with the same partial-chunk result as a live read. */
export const loadRetainedRevision: typeof readRevisionedSave = readRevisionedSave
