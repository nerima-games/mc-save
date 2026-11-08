import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { Effect, Option, Result } from 'effect'
import { effect } from './support/effect-test.js'
import {
  loadRetainedRevision,
  readRevisionedSave,
  writeRevisionedSave,
  writeRevisionedSaveWithCheckpoint,
  type RevisionEntry,
  type RevisionStorage,
} from '../src/application/revisioned-save.js'
import { SaveDecodeError, StorageError } from '../src/domain/errors.js'

type Stored = {
  readonly kind: string
  readonly revision: string
  readonly chunks?: ReadonlyArray<string>
}

type FailurePolicy = (key: string, attempt: number) => StorageError | undefined

const makeStorage = (
  initial: ReadonlyArray<readonly [string, Stored]>,
  failPut?: FailurePolicy,
  failRemove?: (key: string) => StorageError | undefined,
) => {
  const values = new Map<string, Stored>(initial)
  const events: Array<string> = []
  const attempts = new Map<string, number>()
  const storage: RevisionStorage<string, Stored, StorageError, never> = {
    get: (key) => {
      events.push(`get:${key}`)
      return Effect.sync(() => Option.fromUndefinedOr(values.get(key)))
    },
    put: (key, value) =>
      Effect.suspend(() => {
        events.push(`put:${key}`)
        const attempt = (attempts.get(key) ?? 0) + 1
        attempts.set(key, attempt)
        const failure = failPut?.(key, attempt)
        if (failure !== undefined) return Effect.fail(failure)
        values.set(key, value)
        return Effect.void
      }),
    remove: (key) =>
      Effect.suspend(() => {
        events.push(`remove:${key}`)
        const failure = failRemove?.(key)
        if (failure !== undefined) return Effect.fail(failure)
        values.delete(key)
        return Effect.void
      }),
  }
  return { storage, values, events }
}

const makeInput = (
  storage: RevisionStorage<string, Stored, StorageError, never>,
  head: Stored,
  chunks: ReadonlyArray<RevisionEntry<string, Stored>>,
) => ({
  storage,
  head: { key: 'head', value: head },
  chunks,
  chunkKeysFromHead: (previous: Option.Option<Stored>) =>
    Effect.succeed(Option.isSome(previous) ? previous.value.chunks ?? [] : []),
  sameKey: (left: string, right: string) => left === right,
  duplicateKeyError: (key: string) => new StorageError({ operation: 'duplicate', key }),
})

const makeCheckpointInput = (
  storage: RevisionStorage<string, Stored, StorageError, never>,
  head: Stored,
  chunks: ReadonlyArray<RevisionEntry<string, Stored>>,
  isHealthy: (
    head: Stored,
    chunks: ReadonlyArray<RevisionEntry<string, Stored>>,
  ) => Effect.Effect<boolean, StorageError>,
) => ({
  ...makeInput(storage, head, chunks),
  checkpoint: {
    headKey: 'checkpoint:head',
    chunkKey: (revision: Stored, key: string) => `checkpoint:${revision.revision}:${key}`,
    chunkKeysFromHead: (revision: Stored) =>
      Effect.succeed(
        revision.kind === 'invalid-head' ? Option.none<ReadonlyArray<string>>() : Option.some(revision.chunks ?? []),
      ),
    isHealthy,
  },
})

const makeRevisionReader = (
  storage: RevisionStorage<string, Stored, StorageError, never>,
  headKey = 'checkpoint:head',
  lastHealthyRevisionAvailable = true,
) => ({
  storage,
  headKey,
  chunkKey: (revision: Stored, key: string) => `checkpoint:${revision.revision}:${key}`,
  lastHealthyRevisionAvailable,
  decodeHead: (raw: Stored) =>
    raw.kind === 'invalid-head'
      ? Effect.fail(new SaveDecodeError({
          format: 'test/world',
          version: 17,
          reason: 'head is corrupt',
        }))
      : Effect.succeed(raw),
  chunkKeysFromHead: (head: Stored) => Effect.succeed(head.chunks ?? []),
  decodeChunk: (raw: Stored) =>
    raw.kind === 'invalid-chunk'
      ? Effect.fail(new SaveDecodeError({
          format: 'test/chunk',
          version: 9,
          reason: 'chunk is corrupt',
          cause: new Error('encoded chunk payload'),
        }))
      : Effect.succeed(raw),
  missingChunkError: (_head: Stored, key: string) =>
    new SaveDecodeError({
      format: 'test/chunk',
      version: 9,
      reason: `chunk "${key}" is missing`,
    }),
  keyToString: (key: string) => key,
})

describe('writeRevisionedSave', () => {
  effect('writes all chunks before publishing the head and cleans only obsolete chunks', () =>
    Effect.gen(function* () {
      const kept: Stored = { kind: 'chunk', revision: 'old' }
      const obsolete: Stored = { kind: 'chunk', revision: 'old' }
      const storage = makeStorage([
        ['head', { kind: 'head', revision: 'old', chunks: ['kept', 'obsolete'] }],
        ['kept', kept],
        ['obsolete', obsolete],
      ])
      const chunks = [
        { key: 'kept', value: { kind: 'chunk', revision: 'new' } },
        { key: 'new', value: { kind: 'chunk', revision: 'new' } },
      ] as const

      yield* writeRevisionedSave(makeInput(storage.storage, { kind: 'head', revision: 'new', chunks: ['kept', 'new'] }, chunks))

      expect(storage.events.filter((event) => event.startsWith('put:'))).toStrictEqual([
        'put:kept',
        'put:new',
        'put:head',
      ])
      expect(storage.values.get('head')).toStrictEqual({ kind: 'head', revision: 'new', chunks: ['kept', 'new'] })
      expect(storage.values.get('kept')).toStrictEqual({ kind: 'chunk', revision: 'new' })
      expect(storage.values.get('new')).toStrictEqual({ kind: 'chunk', revision: 'new' })
      expect(storage.values.has('obsolete')).toBe(false)
    }),
  )

  effect('restores captured values and removes absent target chunks after a write failure', () =>
    Effect.gen(function* () {
      const primary = new StorageError({ operation: 'put-head', key: 'head' })
      const initialHead: Stored = { kind: 'head', revision: 'old', chunks: ['existing'] }
      const initialChunk: Stored = { kind: 'chunk', revision: 'old' }
      const storage = makeStorage(
        [
          ['head', initialHead],
          ['existing', initialChunk],
        ],
        (key, attempt) => key === 'head' && attempt === 1 ? primary : undefined,
      )
      const chunks = [
        { key: 'existing', value: { kind: 'chunk', revision: 'new' } },
        { key: 'absent', value: { kind: 'chunk', revision: 'new' } },
      ] as const

      const result = yield* Effect.result(
        writeRevisionedSave(makeInput(storage.storage, { kind: 'head', revision: 'new' }, chunks)),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(primary)
      expect(storage.values.get('head')).toBe(initialHead)
      expect(storage.values.get('existing')).toBe(initialChunk)
      expect(storage.values.has('absent')).toBe(false)
    }),
  )

  effect('preserves the primary write error when best-effort rollback fails', () =>
    Effect.gen(function* () {
      const primary = new StorageError({ operation: 'put-head', key: 'head' })
      const secondary = new StorageError({ operation: 'remove', key: 'absent' })
      const storage = makeStorage(
        [['head', { kind: 'head', revision: 'old', chunks: [] }]],
        (key, attempt) => key === 'head' && attempt === 1 ? primary : undefined,
        (key) => key === 'absent' ? secondary : undefined,
      )
      const chunks = [{ key: 'absent', value: { kind: 'chunk', revision: 'new' } }] as const

      const result = yield* Effect.result(
        writeRevisionedSave(makeInput(storage.storage, { kind: 'head', revision: 'new' }, chunks)),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(primary)
      expect(storage.values.get('head')).toStrictEqual({ kind: 'head', revision: 'old', chunks: [] })
    }),
  )

  effect('suppresses obsolete-key cleanup failures after publishing the head', () =>
    Effect.gen(function* () {
      const cleanupFailure = new StorageError({ operation: 'remove', key: 'obsolete' })
      const storage = makeStorage(
        [
          ['head', { kind: 'head', revision: 'old', chunks: ['obsolete'] }],
          ['obsolete', { kind: 'chunk', revision: 'old' }],
        ],
        undefined,
        (key) => key === 'obsolete' ? cleanupFailure : undefined,
      )

      yield* writeRevisionedSave(
        makeInput(storage.storage, { kind: 'head', revision: 'new', chunks: [] }, []),
      )

      expect(storage.values.get('head')).toStrictEqual({ kind: 'head', revision: 'new', chunks: [] })
      expect(storage.values.has('obsolete')).toBe(true)
    }),
  )

  effect('rejects duplicate storage keys before reading or writing', () =>
    Effect.gen(function* () {
      const storage = makeStorage([])
      const chunks = [
        { key: 'same', value: { kind: 'chunk', revision: 'new' } },
        { key: 'same', value: { kind: 'chunk', revision: 'new' } },
      ] as const

      const error = yield* Effect.flip(
        writeRevisionedSave(makeInput(storage.storage, { kind: 'head', revision: 'new' }, chunks)),
      )

      expect(error).toMatchObject({ _tag: 'StorageError', operation: 'duplicate', key: 'same' })
      expect(storage.events).toStrictEqual([])
    }),
  )
})

describe('writeRevisionedSaveWithCheckpoint', () => {
  effect('writes a first revision without publishing an empty checkpoint', () =>
    Effect.gen(function* () {
      const storage = makeStorage([])

      yield* writeRevisionedSaveWithCheckpoint(
        makeCheckpointInput(
          storage.storage,
          { kind: 'head', revision: 'first', chunks: [] },
          [],
          () => Effect.succeed(true),
        ),
      )

      expect(storage.values.get('head')).toStrictEqual({ kind: 'head', revision: 'first', chunks: [] })
      expect(storage.values.has('checkpoint:head')).toBe(false)
      expect(storage.events.filter((event) => event.startsWith('put:'))).toStrictEqual(['put:head'])
    }),
  )

  effect('rejects a checkpoint marker that overlaps a live record', () =>
    Effect.gen(function* () {
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: [] }
      const storage = makeStorage([['head', currentHead]])
      const base = makeCheckpointInput(
        storage.storage,
        { kind: 'head', revision: 'next', chunks: [] },
        [],
        () => Effect.succeed(true),
      )
      const input = { ...base, checkpoint: { ...base.checkpoint, headKey: 'head' } }

      const error = yield* Effect.flip(writeRevisionedSaveWithCheckpoint(input))

      expect(error).toMatchObject({ _tag: 'StorageError', operation: 'duplicate', key: 'head' })
      expect(storage.events.some((event) => event.startsWith('put:'))).toBe(false)
    }),
  )

  effect('rejects checkpoint chunks that overlap live, marker, duplicate, or prior checkpoint keys', () =>
    Effect.gen(function* () {
      const collisionCases = [
        {
          name: 'live chunk',
          currentHead: { kind: 'head', revision: 'current', chunks: ['shared'] },
          chunks: [['shared', { kind: 'chunk', revision: 'current' }]] as const,
          oldCheckpoint: undefined,
          chunkKey: () => 'shared',
          duplicateKey: 'shared',
        },
        {
          name: 'checkpoint marker',
          currentHead: { kind: 'head', revision: 'current', chunks: ['shared'] },
          chunks: [['shared', { kind: 'chunk', revision: 'current' }]] as const,
          oldCheckpoint: undefined,
          chunkKey: () => 'checkpoint:head',
          duplicateKey: 'checkpoint:head',
        },
        {
          name: 'another checkpoint chunk',
          currentHead: { kind: 'head', revision: 'current', chunks: ['left', 'right'] },
          chunks: [
            ['left', { kind: 'chunk', revision: 'current' }],
            ['right', { kind: 'chunk', revision: 'current' }],
          ] as const,
          oldCheckpoint: undefined,
          chunkKey: () => 'checkpoint:duplicate',
          duplicateKey: 'checkpoint:duplicate',
        },
        {
          name: 'prior checkpoint chunk',
          currentHead: { kind: 'head', revision: 'current', chunks: ['shared'] },
          chunks: [['shared', { kind: 'chunk', revision: 'current' }]] as const,
          oldCheckpoint: { kind: 'head', revision: 'older', chunks: ['old-chunk'] },
          chunkKey: () => 'checkpoint:older:old-chunk',
          duplicateKey: 'checkpoint:older:old-chunk',
        },
      ]

      for (const collisionCase of collisionCases) {
        const initial: Array<readonly [string, Stored]> = [
          ['head', collisionCase.currentHead],
          ...collisionCase.chunks,
        ]
        if (collisionCase.oldCheckpoint !== undefined) {
          initial.push(['checkpoint:head', collisionCase.oldCheckpoint])
          initial.push(['checkpoint:older:old-chunk', { kind: 'chunk', revision: 'older' }])
        }
        const storage = makeStorage(initial)
        const base = makeCheckpointInput(
          storage.storage,
          { kind: 'head', revision: 'next', chunks: [] },
          [],
          () => Effect.succeed(true),
        )
        const input = {
          ...base,
          checkpoint: { ...base.checkpoint, chunkKey: collisionCase.chunkKey },
        }

        const error = yield* Effect.flip(writeRevisionedSaveWithCheckpoint(input))

        expect(error).toMatchObject({
          _tag: 'StorageError',
          operation: 'duplicate',
          key: collisionCase.duplicateKey,
        })
        expect(storage.events.some((event) => event.startsWith('put:'))).toBe(false)
      }
    }),
  )

  effect('snapshots every previous chunk before publishing the checkpoint head and new live head', () =>
    Effect.gen(function* () {
      const initialHead: Stored = { kind: 'head', revision: 'old', chunks: ['shared', 'obsolete'] }
      const shared: Stored = { kind: 'chunk', revision: 'old' }
      const obsolete: Stored = { kind: 'chunk', revision: 'old' }
      const storage = makeStorage([
        ['head', initialHead],
        ['shared', shared],
        ['obsolete', obsolete],
      ])
      const input = makeCheckpointInput(
        storage.storage,
        { kind: 'head', revision: 'new', chunks: ['shared', 'fresh'] },
        [
          { key: 'shared', value: { kind: 'chunk', revision: 'new' } },
          { key: 'fresh', value: { kind: 'chunk', revision: 'new' } },
        ],
        () => Effect.succeed(true),
      )

      yield* writeRevisionedSaveWithCheckpoint(input)

      expect(storage.events.filter((event) => event.startsWith('put:'))).toStrictEqual([
        'put:checkpoint:old:shared',
        'put:checkpoint:old:obsolete',
        'put:checkpoint:head',
        'put:shared',
        'put:fresh',
        'put:head',
      ])
      expect(storage.values.get('checkpoint:head')).toBe(initialHead)
      expect(storage.values.get('checkpoint:old:shared')).toBe(shared)
      expect(storage.values.get('checkpoint:old:obsolete')).toBe(obsolete)
      expect(storage.values.get('shared')).toStrictEqual({ kind: 'chunk', revision: 'new' })
      expect(storage.values.has('obsolete')).toBe(false)
    }),
  )

  effect('replaces only the prior checkpoint after the new live head publishes', () =>
    Effect.gen(function* () {
      const oldCheckpoint: Stored = { kind: 'head', revision: 'older', chunks: ['older-chunk'] }
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: ['shared'] }
      const currentChunk: Stored = { kind: 'chunk', revision: 'current' }
      const oldCheckpointChunk: Stored = { kind: 'chunk', revision: 'older' }
      const storage = makeStorage([
        ['head', currentHead],
        ['shared', currentChunk],
        ['checkpoint:head', oldCheckpoint],
        ['checkpoint:older:older-chunk', oldCheckpointChunk],
      ])

      yield* writeRevisionedSaveWithCheckpoint(
        makeCheckpointInput(
          storage.storage,
          { kind: 'head', revision: 'next', chunks: [] },
          [],
          () => Effect.succeed(true),
        ),
      )

      expect(storage.values.get('checkpoint:head')).toBe(currentHead)
      expect(storage.values.get('checkpoint:current:shared')).toBe(currentChunk)
      expect(storage.values.has('checkpoint:older:older-chunk')).toBe(false)
      expect(storage.events.indexOf('put:head')).toBeLessThan(
        storage.events.indexOf('remove:checkpoint:older:older-chunk'),
      )
    }),
  )

  effect('publishes a valid checkpoint when the older checkpoint head cannot be inspected', () =>
    Effect.gen(function* () {
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: ['shared'] }
      const currentChunk: Stored = { kind: 'chunk', revision: 'current' }
      const storage = makeStorage([
        ['head', currentHead],
        ['shared', currentChunk],
        ['checkpoint:head', { kind: 'invalid-head', revision: 'broken', chunks: [] }],
      ])

      yield* writeRevisionedSaveWithCheckpoint(
        makeCheckpointInput(
          storage.storage,
          { kind: 'head', revision: 'next', chunks: [] },
          [],
          () => Effect.succeed(true),
        ),
      )

      expect(storage.values.get('checkpoint:head')).toBe(currentHead)
      expect(storage.values.get('checkpoint:current:shared')).toBe(currentChunk)
      expect(storage.values.get('head')).toStrictEqual({ kind: 'head', revision: 'next', chunks: [] })
    }),
  )

  effect('keeps the old checkpoint and live revision when a checkpoint copy fails', () =>
    Effect.gen(function* () {
      const priorCheckpoint: Stored = { kind: 'head', revision: 'safe', chunks: ['safe-chunk'] }
      const priorCheckpointChunk: Stored = { kind: 'chunk', revision: 'safe' }
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: ['shared'] }
      const currentChunk: Stored = { kind: 'chunk', revision: 'current' }
      const failure = new StorageError({ operation: 'checkpoint.put', key: 'checkpoint:current:shared' })
      const storage = makeStorage(
        [
          ['head', currentHead],
          ['shared', currentChunk],
          ['checkpoint:head', priorCheckpoint],
          ['checkpoint:safe:safe-chunk', priorCheckpointChunk],
        ],
        (key) => key === 'checkpoint:current:shared' ? failure : undefined,
      )

      const result = yield* Effect.result(
        writeRevisionedSaveWithCheckpoint(
          makeCheckpointInput(
            storage.storage,
            { kind: 'head', revision: 'next', chunks: ['shared'] },
            [{ key: 'shared', value: { kind: 'chunk', revision: 'next' } }],
            () => Effect.succeed(true),
          ),
        ),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(failure)
      expect(storage.values.get('checkpoint:head')).toBe(priorCheckpoint)
      expect(storage.values.get('checkpoint:safe:safe-chunk')).toBe(priorCheckpointChunk)
      expect(storage.values.get('head')).toBe(currentHead)
      expect(storage.values.get('shared')).toBe(currentChunk)
      expect(storage.events).not.toContain('put:head')
    }),
  )

  effect('restores the old checkpoint marker when publishing a checkpoint head fails', () =>
    Effect.gen(function* () {
      const priorCheckpoint: Stored = { kind: 'head', revision: 'safe', chunks: ['safe-chunk'] }
      const priorCheckpointChunk: Stored = { kind: 'chunk', revision: 'safe' }
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: ['shared'] }
      const currentChunk: Stored = { kind: 'chunk', revision: 'current' }
      const failure = new StorageError({ operation: 'checkpoint.head.put', key: 'checkpoint:head' })
      const storage = makeStorage(
        [
          ['head', currentHead],
          ['shared', currentChunk],
          ['checkpoint:head', priorCheckpoint],
          ['checkpoint:safe:safe-chunk', priorCheckpointChunk],
        ],
        (key, attempt) => key === 'checkpoint:head' && attempt === 1 ? failure : undefined,
      )

      const result = yield* Effect.result(
        writeRevisionedSaveWithCheckpoint(
          makeCheckpointInput(
            storage.storage,
            { kind: 'head', revision: 'next', chunks: [] },
            [],
            () => Effect.succeed(true),
          ),
        ),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(failure)
      expect(storage.values.get('checkpoint:head')).toBe(priorCheckpoint)
      expect(storage.values.get('checkpoint:safe:safe-chunk')).toBe(priorCheckpointChunk)
      expect(storage.values.has('checkpoint:current:shared')).toBe(false)
      expect(storage.values.get('head')).toBe(currentHead)
      expect(storage.values.get('shared')).toBe(currentChunk)
    }),
  )

  effect('removes copied chunks when a first checkpoint marker write fails', () =>
    Effect.gen(function* () {
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: ['shared'] }
      const currentChunk: Stored = { kind: 'chunk', revision: 'current' }
      const failure = new StorageError({ operation: 'checkpoint.head.put', key: 'checkpoint:head' })
      const storage = makeStorage(
        [['head', currentHead], ['shared', currentChunk]],
        (key, attempt) => key === 'checkpoint:head' && attempt === 1 ? failure : undefined,
      )

      const result = yield* Effect.result(
        writeRevisionedSaveWithCheckpoint(
          makeCheckpointInput(
            storage.storage,
            { kind: 'head', revision: 'next', chunks: [] },
            [],
            () => Effect.succeed(true),
          ),
        ),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(failure)
      expect(storage.values.has('checkpoint:head')).toBe(false)
      expect(storage.values.has('checkpoint:current:shared')).toBe(false)
      expect(storage.values.get('head')).toBe(currentHead)
      expect(storage.values.get('shared')).toBe(currentChunk)
    }),
  )

  effect('keeps copied chunks when restoring a failed checkpoint marker also fails', () =>
    Effect.gen(function* () {
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: ['shared'] }
      const currentChunk: Stored = { kind: 'chunk', revision: 'current' }
      const failure = new StorageError({ operation: 'checkpoint.head.put', key: 'checkpoint:head' })
      const restoreFailure = new StorageError({ operation: 'checkpoint.head.remove', key: 'checkpoint:head' })
      const storage = makeStorage(
        [['head', currentHead], ['shared', currentChunk]],
        (key) => key === 'checkpoint:head' ? failure : undefined,
        (key) => key === 'checkpoint:head' ? restoreFailure : undefined,
      )

      const result = yield* Effect.result(
        writeRevisionedSaveWithCheckpoint(
          makeCheckpointInput(
            storage.storage,
            { kind: 'head', revision: 'next', chunks: [] },
            [],
            () => Effect.succeed(true),
          ),
        ),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(failure)
      expect(storage.values.has('checkpoint:head')).toBe(false)
      expect(storage.values.get('checkpoint:current:shared')).toBe(currentChunk)
      expect(storage.values.get('head')).toBe(currentHead)
    }),
  )

  effect('keeps the checkpoint of the restored revision when live publication rolls back', () =>
    Effect.gen(function* () {
      const priorCheckpoint: Stored = { kind: 'head', revision: 'older', chunks: ['older-chunk'] }
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: ['shared'] }
      const currentChunk: Stored = { kind: 'chunk', revision: 'current' }
      const failure = new StorageError({ operation: 'head.put', key: 'head' })
      const storage = makeStorage(
        [
          ['head', currentHead],
          ['shared', currentChunk],
          ['checkpoint:head', priorCheckpoint],
          ['checkpoint:older:older-chunk', { kind: 'chunk', revision: 'older' }],
        ],
        (key, attempt) => key === 'head' && attempt === 1 ? failure : undefined,
      )

      const result = yield* Effect.result(
        writeRevisionedSaveWithCheckpoint(
          makeCheckpointInput(
            storage.storage,
            { kind: 'head', revision: 'next', chunks: ['shared'] },
            [{ key: 'shared', value: { kind: 'chunk', revision: 'next' } }],
            () => Effect.succeed(true),
          ),
        ),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(failure)
      expect(storage.values.get('checkpoint:head')).toBe(currentHead)
      expect(storage.values.get('checkpoint:current:shared')).toBe(currentChunk)
      expect(storage.values.get('head')).toBe(currentHead)
      expect(storage.values.get('shared')).toBe(currentChunk)
      expect(storage.values.get('checkpoint:older:older-chunk')).toBeDefined()
    }),
  )

  effect('leaves the last healthy checkpoint intact when the current revision fails validation', () =>
    Effect.gen(function* () {
      const priorCheckpoint: Stored = { kind: 'head', revision: 'safe', chunks: ['safe-chunk'] }
      const currentHead: Stored = { kind: 'head', revision: 'invalid', chunks: ['missing'] }
      const storage = makeStorage([
        ['head', currentHead],
        ['checkpoint:head', priorCheckpoint],
        ['checkpoint:safe:safe-chunk', { kind: 'chunk', revision: 'safe' }],
      ])

      yield* writeRevisionedSaveWithCheckpoint(
        makeCheckpointInput(
          storage.storage,
          { kind: 'head', revision: 'next', chunks: [] },
          [],
          () => Effect.succeed(false),
        ),
      )

      expect(storage.values.get('checkpoint:head')).toBe(priorCheckpoint)
      expect(storage.values.get('head')).toStrictEqual({ kind: 'head', revision: 'next', chunks: [] })
    }),
  )

  effect('does not replace a checkpoint when a complete current revision fails health validation', () =>
    Effect.gen(function* () {
      const priorCheckpoint: Stored = { kind: 'head', revision: 'safe', chunks: ['safe-chunk'] }
      const currentHead: Stored = { kind: 'head', revision: 'current', chunks: ['shared'] }
      const currentChunk: Stored = { kind: 'chunk', revision: 'current' }
      const storage = makeStorage([
        ['head', currentHead],
        ['shared', currentChunk],
        ['checkpoint:head', priorCheckpoint],
        ['checkpoint:safe:safe-chunk', { kind: 'chunk', revision: 'safe' }],
      ])

      yield* writeRevisionedSaveWithCheckpoint(
        makeCheckpointInput(
          storage.storage,
          { kind: 'head', revision: 'next', chunks: [] },
          [],
          () => Effect.succeed(false),
        ),
      )

      expect(storage.values.get('checkpoint:head')).toBe(priorCheckpoint)
      expect(storage.values.has('checkpoint:current:shared')).toBe(false)
      expect(storage.values.get('head')).toStrictEqual({ kind: 'head', revision: 'next', chunks: [] })
      expect(storage.values.get('shared')).toBe(currentChunk)
    }),
  )

  it('preserves any valid prior chunk set under revision-specific keys', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), { maxLength: 12 }),
        async (ids) => {
          const keys = ids.map((id) => `chunk-${id}`)
          const oldHead: Stored = { kind: 'head', revision: 'old', chunks: keys }
          const oldChunks = keys.map((key) => [key, { kind: 'chunk', revision: 'old' }] as const)
          const storage = makeStorage([['head', oldHead], ...oldChunks])

          await Effect.runPromise(
            writeRevisionedSaveWithCheckpoint(
              makeCheckpointInput(
                storage.storage,
                { kind: 'head', revision: 'new', chunks: [] },
                [],
                () => Effect.succeed(true),
              ),
            ),
          )

          const loaded = await Effect.runPromise(
            readRevisionedSave(makeRevisionReader(storage.storage)),
          )
          expect(loaded).toStrictEqual(
            Option.some({
              head: oldHead,
              chunks: keys.map((key) => ({ key, value: { kind: 'chunk', revision: 'old' } })),
              failures: [],
            }),
          )
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe('readRevisionedSave', () => {
  effect('returns none when no revision head is stored', () =>
    Effect.gen(function* () {
      const storage = makeStorage([])

      const loaded = yield* readRevisionedSave(makeRevisionReader(storage.storage))

      expect(loaded).toStrictEqual(Option.none())
    }),
  )

  effect('returns good chunks and typed failures for only missing or corrupt chunks', () =>
    Effect.gen(function* () {
      const head: Stored = { kind: 'head', revision: 'saved', chunks: ['good', 'missing', 'bad'] }
      const storage = makeStorage([
        ['checkpoint:head', head],
        ['checkpoint:saved:good', { kind: 'chunk', revision: 'saved' }],
        ['checkpoint:saved:bad', { kind: 'invalid-chunk', revision: 'saved' }],
      ])

      const loaded = yield* readRevisionedSave(makeRevisionReader(storage.storage))

      expect(Option.isSome(loaded)).toBe(true)
      if (!Option.isSome(loaded)) return
      expect(loaded.value.head).toBe(head)
      expect(loaded.value.chunks).toStrictEqual([
        { key: 'good', value: { kind: 'chunk', revision: 'saved' } },
      ])
      expect(loaded.value.failures).toHaveLength(2)
      expect(JSON.stringify(loaded.value.failures)).not.toContain('encoded chunk payload')
      expect(loaded.value.failures.map((error) => ({
        _tag: error._tag,
        format: error.format,
        version: error.version,
        reason: error.reason,
        record: error.record,
        repair: error.repair,
      }))).toStrictEqual([
        {
          _tag: 'SaveDecodeError',
          format: 'test/chunk',
          version: 9,
          reason: 'chunk "missing" is missing',
          record: { _tag: 'Chunk', key: 'checkpoint:saved:missing' },
          repair: {
            lastHealthyRevisionAvailable: true,
            discardableChunkKeys: ['checkpoint:saved:missing'],
          },
        },
        {
          _tag: 'SaveDecodeError',
          format: 'test/chunk',
          version: 9,
          reason: 'chunk is corrupt',
          record: { _tag: 'Chunk', key: 'checkpoint:saved:bad' },
          repair: {
            lastHealthyRevisionAvailable: true,
            discardableChunkKeys: ['checkpoint:saved:bad'],
          },
        },
      ])
    }),
  )

  effect('fails with typed head metadata when the revision head is corrupt', () =>
    Effect.gen(function* () {
      const storage = makeStorage([[
        'checkpoint:head',
        { kind: 'invalid-head', revision: 'bad', chunks: ['unused'] },
      ]])

      const error = yield* Effect.flip(
        loadRetainedRevision(makeRevisionReader(storage.storage, 'checkpoint:head', false)),
      )

      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        version: 17,
        record: { _tag: 'Head', key: 'checkpoint:head' },
        repair: { lastHealthyRevisionAvailable: false, discardableChunkKeys: [] },
      })
      expect(storage.events.some((event) => event.startsWith('get:checkpoint:bad:'))).toBe(false)
    }),
  )

  effect('annotates head errors when chunk-key metadata cannot be decoded', () =>
    Effect.gen(function* () {
      const head: Stored = { kind: 'head', revision: 'bad', chunks: ['unused'] }
      const storage = makeStorage([['checkpoint:head', head]])
      const failure = new SaveDecodeError({
        format: 'test/head',
        version: 3,
        reason: 'chunk list is corrupt',
      })
      const input = {
        ...makeRevisionReader(storage.storage, 'checkpoint:head', false),
        chunkKeysFromHead: () => Effect.fail(failure),
      }

      const error = yield* Effect.flip(readRevisionedSave(input))

      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        reason: 'chunk list is corrupt',
        record: { _tag: 'Head', key: 'checkpoint:head' },
        repair: { lastHealthyRevisionAvailable: false, discardableChunkKeys: [] },
      })
    }),
  )

  effect('keeps operational storage read failures as failures', () =>
    Effect.gen(function* () {
      const failure = new StorageError({ operation: 'chunk.get', key: 'checkpoint:saved:bad' })
      const base = makeStorage([[
        'checkpoint:head',
        { kind: 'head', revision: 'saved', chunks: ['bad'] },
      ]])
      const storage: RevisionStorage<string, Stored, StorageError, never> = {
        ...base.storage,
        get: (key) => key === 'checkpoint:saved:bad' ? Effect.fail(failure) : base.storage.get(key),
      }

      const error = yield* Effect.flip(readRevisionedSave(makeRevisionReader(storage)))

      expect(error).toBe(failure)
    }),
  )
})
