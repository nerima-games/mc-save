import { describe, expect } from 'vitest'
import { Effect, Option, Result } from 'effect'
import { effect } from './support/effect-test.js'
import { writeRevisionedSave, type RevisionEntry, type RevisionStorage } from '../src/application/revisioned-save.js'
import { StorageError } from '../src/domain/errors.js'

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
