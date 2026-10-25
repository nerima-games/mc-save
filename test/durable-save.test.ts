import { describe, expect, it } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Option, Result, Schema } from 'effect'
import { SaveChecksum, SaveFormatVersion, SaveMaxBytes } from '../src/domain/brand-types.js'
import {
  loadDurably,
  saveDurably,
  sealSaveEnvelope as sealSaveEnvelopeResult,
  validateSaveEnvelope,
} from '../src/domain/durable-save.js'
import type { SaveEnvelope } from '../src/domain/envelope.js'
import { StorageError } from '../src/domain/errors.js'
import { defineFormat as defineFormatResult } from '../src/domain/format.js'
import { DEFAULT_MAX_SAVE_BYTES, sameSaveEnvelope, sealAndValidateSaveEnvelope } from '../src/domain/integrity.js'
import { canonicalize } from '../src/domain/integrity-canonical.js'
import { makeInMemoryStorage, SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { jsonExtensions, saveEnvelope } from './support/save-envelope.js'

// Widens a value's static type to `T` with NO runtime transformation and no type assertion:
// `Record<string, any>` indexing is `any` by construction, assignable anywhere with zero compiler
// complaint. Used to construct a deliberately invalid/malformed envelope so a test proves runtime
// validation — not the type checker — rejects it.
const widen = <T,>(value: unknown): T => {
  const bag: Record<string, any> = {}
  bag['value'] = value
  return bag['value']
}

const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<A, I>
}) => Result.getOrThrow(defineFormatResult(spec))
const State = defineFormat({
  name: 'mc-save/test/durable',
  version: 1,
  schema: Schema.Struct({ score: Schema.Number, label: Schema.String }),
})

const sealEnvelopeForTest = (
  envelope: Parameters<typeof sealSaveEnvelopeResult>[0],
  extensions?: Readonly<Record<string, unknown>>,
): SaveEnvelope =>
  Result.getOrThrow(
    sealSaveEnvelopeResult(envelope, extensions === undefined ? undefined : jsonExtensions(extensions)),
  )

const CompleteWorld = defineFormat({
  name: 'mc-save/test/complete-world',
  version: 1,
  schema: Schema.Struct({
    dimension: Schema.String,
    player: Schema.Struct({
      id: Schema.String,
      position: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
      health: Schema.Number,
      inventory: Schema.Array(Schema.Struct({ item: Schema.String, count: Schema.Number })),
    }),
    entities: Schema.Array(
      Schema.Struct({ id: Schema.String, kind: Schema.String, health: Schema.Number, vehicle: Schema.NullOr(Schema.String) }),
    ),
    bosses: Schema.Array(
      Schema.Struct({ id: Schema.String, kind: Schema.String, health: Schema.Number, phase: Schema.String }),
    ),
  }),
})

const key = SaveKey('world-1')
const previousKey = SaveKey('world-1::previous')

describe('durable save checkpoints', () => {
  effect('fails invalid save options instead of applying defaults', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      const invalidLimit = yield* Effect.result(
        saveDurably(
          State,
          key,
          { score: 1, label: 'invalid limit' },
          widen<Parameters<typeof saveDurably>[3]>({ maxBytes: null }),
        ).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(invalidLimit._tag).toBe('Failure')
      if (invalidLimit._tag === 'Failure') {
        expect(invalidLimit.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'maxBytes must be a non-negative safe integer',
        })
      }

      const invalidExtensions = yield* Effect.result(
        saveDurably(
          State,
          key,
          { score: 1, label: 'invalid extensions' },
          widen<Parameters<typeof saveDurably>[3]>({ extensions: null }),
        ).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(invalidExtensions._tag).toBe('Failure')
      if (invalidExtensions._tag === 'Failure') {
        expect(invalidExtensions.failure).toMatchObject({ _tag: 'SaveDecodeError' })
        expect(invalidExtensions.failure.message).toContain('extensions must be a plain string-keyed object')
      }
    }),
  )

  effect('falls back to the previous known-good checkpoint when latest is corrupt', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))

      const latest = yield* storage.get(key)
      if (Option.isNone(latest)) throw new Error('latest checkpoint was not written')
      yield* storage.put(key, { ...latest.value, payload: { score: 999, label: 'tampered' } })

      const restored = yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage))
      expect(restored).toStrictEqual(Option.some({ score: 1, label: 'first' }))
    }),
  )

  effect('falls back to the previous known-good checkpoint when latest is missing', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      yield* storage.remove(key)

      const restored = yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage))
      expect(restored).toStrictEqual(Option.some({ score: 1, label: 'first' }))
    }),
  )

  effect('decodes a valid checkpoint above the default byte limit with the caller limit', () =>
    Effect.gen(function* () {
      const maxBytes = SaveMaxBytes(DEFAULT_MAX_SAVE_BYTES + 1_024)
      const value = { score: 1, label: 'x'.repeat(DEFAULT_MAX_SAVE_BYTES) }
      const envelope = sealEnvelopeForTest(saveEnvelope(State.name, State.version, value))
      expect(envelope.integrity.byteLength).toBeGreaterThan(DEFAULT_MAX_SAVE_BYTES)

      const storage = yield* makeInMemoryStorage
      yield* storage.put(key, envelope)

      const restored = yield* loadDurably(State, key, maxBytes).pipe(Effect.provideService(StoragePort, storage))
      expect(restored).toStrictEqual(Option.some(value))
    }),
  )

  effect('does not fall back when latest is a valid checkpoint from a newer build', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      yield* storage.put(key, sealEnvelopeForTest(saveEnvelope(State.name, State.version + 1, { score: 3, label: 'future' })))

      const result = yield* Effect.result(loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage)))
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure).toMatchObject({ _tag: 'SaveDecodeError', version: State.version + 1 })
        expect(result.failure.message).toContain('newer build')
      }
    }),
  )

  effect('does not overwrite a valid checkpoint from a newer build', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      const previous = yield* storage.get(previousKey)
      const future = sealEnvelopeForTest(saveEnvelope(State.name, State.version + 1, { score: 3, label: 'future' }))
      yield* storage.put(key, future)

      const result = yield* Effect.result(
        saveDurably(State, key, { score: 4, label: 'replacement' }).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure).toMatchObject({ _tag: 'SaveDecodeError', version: State.version + 1 })
        expect(result.failure.message).toContain('newer build')
      }
      expect(yield* storage.get(key)).toStrictEqual(Option.some(future))
      expect(yield* storage.get(previousKey)).toStrictEqual(previous)
    }),
  )

  effect('fails without replacing a good previous checkpoint when latest is corrupt', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      const latest = yield* storage.get(key)
      if (Option.isNone(latest)) throw new Error('latest checkpoint was not written')
      const corrupt = {
        ...latest.value,
        integrity: { ...latest.value.integrity, checksum: Result.getOrThrow(SaveChecksum.result('00000000')) },
      }
      yield* storage.put(key, corrupt)

      const write = yield* Effect.result(
        saveDurably(State, key, { score: 3, label: 'third' }).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(write._tag).toBe('Failure')
      if (write._tag === 'Failure') expect(write.failure._tag).toBe('SaveDecodeError')
      expect(yield* storage.get(key)).toStrictEqual(Option.some(corrupt))

      const previous = yield* storage.get(previousKey)
      expect(Option.isSome(previous) && previous.value.payload).toStrictEqual({ score: 1, label: 'first' })
    }),
  )

  effect('keeps the existing checkpoint when the atomic commit is interrupted', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'stable' }).pipe(Effect.provideService(StoragePort, storage))
      const interrupted = {
        ...storage,
        commitBatch: () => Effect.fail(new StorageError({ operation: 'quota-exceeded' })),
      }

      const failure = yield* Effect.result(
        saveDurably(State, key, { score: 2, label: 'lost' }).pipe(Effect.provideService(StoragePort, interrupted)),
      )
      expect(failure._tag).toBe('Failure')
      expect(yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage))).toStrictEqual(
        Option.some({ score: 1, label: 'stable' }),
      )
    }),
  )

  effect('retains opaque extensions across later checkpoints', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      const extensions = { futureInventory: { slots: [1, 2, 3] } }
      yield* saveDurably(State, key, { score: 1, label: 'first' }, { extensions: jsonExtensions(extensions) }).pipe(
        Effect.provideService(StoragePort, storage),
      )
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))

      const latest = yield* storage.get(key)
      expect(Option.isSome(latest) && latest.value.extensions).toStrictEqual(extensions)
    }),
  )

  effect('inherits extensions from the previous checkpoint when latest is missing', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      const extensions = { futureInventory: { slots: [1, 2, 3] } }
      const previous = sealEnvelopeForTest(
        saveEnvelope(State.name, State.version, { score: 1, label: 'previous' }),
        extensions,
      )
      yield* storage.put(previousKey, previous)

      yield* saveDurably(State, key, { score: 2, label: 'next' }).pipe(Effect.provideService(StoragePort, storage))

      const latest = yield* storage.get(key)
      expect(Option.isSome(latest) && latest.value.extensions).toStrictEqual(extensions)
    }),
  )

  effect('does not decode the previous checkpoint when latest is healthy', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'previous' }).pipe(
        Effect.provideService(StoragePort, storage),
      )
      yield* saveDurably(State, key, { score: 2, label: 'latest' }).pipe(
        Effect.provideService(StoragePort, storage),
      )

      const inaccessiblePayload = { score: 'not-a-number', label: 'previous payload must remain opaque' }
      const previous = yield* storage.get(previousKey)
      if (Option.isNone(previous)) throw new Error('previous checkpoint was not written')
      yield* storage.put(previousKey, { ...previous.value, payload: inaccessiblePayload })

      yield* saveDurably(State, key, { score: 3, label: 'next' }).pipe(
        Effect.provideService(StoragePort, storage),
      )
      expect(yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage))).toStrictEqual(
        Option.some({ score: 3, label: 'next' }),
      )
    }),
  )

  effect('serializes concurrent checkpoints for the same world', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 0, label: 'initial' }).pipe(
        Effect.provideService(StoragePort, storage),
      )
      let activeCommits = 0
      let maximumActiveCommits = 0
      const delayed = {
        ...storage,
        commitBatch: (mutations: Parameters<typeof storage.commitBatch>[0]) =>
          Effect.gen(function* () {
            activeCommits += 1
            maximumActiveCommits = Math.max(maximumActiveCommits, activeCommits)
            yield* Effect.callback<void>((resume) => {
              queueMicrotask(() => resume(Effect.void))
            })
            yield* storage.commitBatch(mutations)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeCommits -= 1
              }),
            ),
          ),
      }

      yield* Effect.all(
        [1, 2, 3].map((score) =>
          saveDurably(State, key, { score, label: `save-${String(score)}` }).pipe(
            Effect.provideService(StoragePort, delayed),
          ),
        ),
        { concurrency: 'unbounded', discard: true },
      )

      expect(maximumActiveCommits).toBe(1)
      expect(yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, delayed))).toStrictEqual(
        Option.some({ score: 3, label: 'save-3' }),
      )
      const previous = yield* delayed.get(previousKey)
      expect(Option.isSome(previous) && previous.value.payload).toStrictEqual({ score: 2, label: 'save-2' })
    }),
  )

  effect('keeps independent world locks independent', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      let activeCommits = 0
      let maximumActiveCommits = 0
      const delayed = {
        ...storage,
        commitBatch: (mutations: Parameters<typeof storage.commitBatch>[0]) =>
          Effect.gen(function* () {
            activeCommits += 1
            maximumActiveCommits = Math.max(maximumActiveCommits, activeCommits)
            yield* Effect.callback<void>((resume) => {
              queueMicrotask(() => resume(Effect.void))
            })
            yield* storage.commitBatch(mutations)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeCommits -= 1
              }),
            ),
          ),
      }

      yield* Effect.all(
        [
          saveDurably(State, key, { score: 1, label: 'world-1' }),
          saveDurably(State, SaveKey('world-2'), { score: 2, label: 'world-2' }),
        ].map((save) => save.pipe(Effect.provideService(StoragePort, delayed))),
        { concurrency: 'unbounded', discard: true },
      )

      expect(maximumActiveCommits).toBe(2)
    }),
  )

  effect('round-trips dimension, player, entity, vehicle, and boss state', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      const complete = {
        dimension: 'minecraft:the_end',
        player: {
          id: 'player-1',
          position: [12.5, 64, -7.25] as const,
          health: 17.5,
          inventory: [
            { item: 'minecraft:elytra', count: 1 },
            { item: 'minecraft:firework_rocket', count: 32 },
          ],
        },
        entities: [
          { id: 'horse-1', kind: 'minecraft:horse', health: 24, vehicle: null },
          { id: 'player-1', kind: 'minecraft:player', health: 17.5, vehicle: 'horse-1' },
        ],
        bosses: [
          { id: 'dragon-1', kind: 'minecraft:ender_dragon', health: 153, phase: 'STRAFE_PLAYER' },
          { id: 'wither-1', kind: 'minecraft:wither', health: 260, phase: 'ARMORED' },
        ],
      }

      yield* saveDurably(CompleteWorld, key, complete).pipe(Effect.provideService(StoragePort, storage))
      expect(yield* loadDurably(CompleteWorld, key).pipe(Effect.provideService(StoragePort, storage))).toStrictEqual(
        Option.some(complete),
      )
    }),
  )

  effect('rejects envelopes without integrity metadata', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      const draft = widen<SaveEnvelope>(saveEnvelope(State.name, 1, { score: 7, label: 'draft' }))
      const malformedStorage = {
        ...storage,
        readBatch: () => Effect.succeed([Option.some(draft), Option.none()]),
      }

      const result = yield* Effect.result(loadDurably(State, key).pipe(Effect.provideService(StoragePort, malformedStorage)))
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('SaveDecodeError')
        if (result.failure._tag === 'SaveDecodeError') expect(result.failure.reason).toContain('well-formed')
      }
    }),
  )

effect('fails when storage returns an incomplete durable checkpoint batch', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      const incompleteStorage = {
        ...storage,
        readBatch: () => Effect.succeed([Option.none()]),
      }

      const loaded = yield* Effect.result(
        loadDurably(State, key).pipe(Effect.provideService(StoragePort, incompleteStorage)),
      )
      expect(loaded._tag).toBe('Failure')
      if (loaded._tag === 'Failure') {
        expect(loaded.failure._tag).toBe('StorageError')
        if (loaded.failure._tag === 'StorageError') {
          expect(loaded.failure.operation).toBe('durable.readBatch')
        }
      }

      const saved = yield* Effect.result(
        saveDurably(State, key, { score: 1, label: 'first' }).pipe(
          Effect.provideService(StoragePort, incompleteStorage),
        ),
      )
      expect(saved._tag).toBe('Failure')
      if (saved._tag === 'Failure') {
        expect(saved.failure._tag).toBe('StorageError')
        if (saved.failure._tag === 'StorageError') {
          expect(saved.failure.operation).toBe('durable.readBatch')
        }
      }

      const missingLatest = [Option.none(), Option.none()]
      Object.defineProperty(missingLatest, '0', { value: undefined })
      const missingPrevious = [Option.none(), Option.none()]
      Object.defineProperty(missingPrevious, '1', { value: undefined })
      for (const batch of [missingLatest, missingPrevious]) {
        const missingSlotStorage = { ...storage, readBatch: () => Effect.succeed(batch) }
        const result = yield* Effect.result(
          loadDurably(State, key).pipe(Effect.provideService(StoragePort, missingSlotStorage)),
        )
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('StorageError')
          if (result.failure._tag === 'StorageError') {
            expect(result.failure.operation).toBe('durable.readBatch')
          }
        }
      }

      const nonArrayStorage = { ...storage }
      Object.defineProperty(nonArrayStorage, 'readBatch', { value: () => Effect.succeed(null) })
      const nonArrayResult = yield* Effect.result(
        loadDurably(State, key).pipe(Effect.provideService(StoragePort, nonArrayStorage)),
      )
      expect(nonArrayResult._tag).toBe('Failure')
      if (nonArrayResult._tag === 'Failure') {
        expect(nonArrayResult.failure._tag).toBe('StorageError')
        if (nonArrayResult.failure._tag === 'StorageError') {
          expect(nonArrayResult.failure.operation).toBe('durable.readBatch')
        }
      }
    }),
  )

  effect('treats a key that was never written as a new world, not an error', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      expect(
        yield* loadDurably(State, SaveKey('never-written')).pipe(Effect.provideService(StoragePort, storage)),
      ).toStrictEqual(Option.none())
    }),
  )

  effect('refuses to write a value that seals to a non-finite number, before anything is stored', () =>
    Effect.gen(function* () {
      // `saveDurably`'s own `sealAndValidateSaveEnvelope`, distinct from the
      // standalone `validateSaveEnvelope` exercised in "save integrity" below —
      // it has its own copy of the same non-finite/oversized checks, reached
      // only through the write path.
      const storage = yield* makeInMemoryStorage

      const result = yield* Effect.result(
        saveDurably(State, key, { score: Number.NaN, label: 'x' }).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('SaveDecodeError')
        if (result.failure._tag === 'SaveDecodeError') {
          expect(result.failure.reason).toBe('save contains a non-finite number')
        }
      }
      expect(yield* storage.get(key)).toStrictEqual(Option.none())
    }),
  )

  effect('refuses to write a value whose sealed envelope exceeds the configured byte limit', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage

      const result = yield* Effect.result(
        saveDurably(State, key, { score: 1, label: 'this label is long enough to blow a tiny byte budget' }, {
          maxBytes: SaveMaxBytes(8),
        }).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('SaveDecodeError')
        if (result.failure._tag === 'SaveDecodeError') {
          expect(result.failure.reason).toContain('byte limit')
        }
      }
      expect(yield* storage.get(key)).toStrictEqual(Option.none())
    }),
  )

  effect('fails when latest parses but fails to decode (SaveDecodeError, non-future)', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))

      const badSchema = sealEnvelopeForTest(saveEnvelope(State.name, State.version, { score: 'nope', label: 'bad' }))
      yield* storage.put(key, badSchema)

      const write = yield* Effect.result(
        saveDurably(State, key, { score: 3, label: 'third' }).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(write._tag).toBe('Failure')
      if (write._tag === 'Failure') expect(write.failure._tag).toBe('SaveDecodeError')
      expect(yield* storage.get(key)).toStrictEqual(Option.some(badSchema))

      const previous = yield* storage.get(previousKey)
      expect(Option.isSome(previous) && previous.value.payload).toStrictEqual({ score: 1, label: 'first' })
    }),
  )

  /**
   * The four fallback branches of `loadDurably`'s `Effect.catchTags` block:
   * `latest` parses as a well-formed, integrity-valid envelope (so it clears
   * `readStoredEnvelope`, unlike the "corrupt"/"missing" cases above, which
   * fail earlier) but `decodeSave` itself then rejects it because the payload
   * does not satisfy the current schema (`SaveDecodeError`) — crossed with
   * whether a `previous` checkpoint exists to fall back to.
   */
  describe('falling back past a latest that parses but does not decode', () => {
    effect('SaveDecodeError + a previous checkpoint: falls back to previous', () =>
      Effect.gen(function* () {
        const storage = yield* makeInMemoryStorage
        yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
        yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))

        // Sealed (so it clears validateSaveEnvelope) but shaped so the current
        // schema's `Schema.decodeUnknown` rejects it — `score` must be a number.
        const badSchema = sealEnvelopeForTest(saveEnvelope(State.name, State.version, { score: 'nope', label: 'bad' }))
        yield* storage.put(key, badSchema)

        const restored = yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage))
        expect(restored).toStrictEqual(Option.some({ score: 1, label: 'first' }))
      }),
    )

    effect('latest is not even a well-formed envelope, and there is no previous: fails with that error', () =>
      Effect.gen(function* () {
        // One level earlier than the two cases above: this fails inside
        // `readStoredEnvelope` itself (line ~200), before `decodeSave` is ever
        // reached, because the stored value cannot even be parsed as a
        // `SaveEnvelope`. `Effect.result(readStoredEnvelope(...))` comes back
        // `Failure` directly, so `loadDurably` never reaches its
        // `Effect.catchTags` block at all for this one.
        const storage = yield* makeInMemoryStorage
        const malformed = widen<SaveEnvelope>({ format: '', version: 0, payload: null })
        const malformedStorage = {
          ...storage,
          readBatch: () => Effect.succeed([Option.some(malformed), Option.none()]),
        }

        const result = yield* Effect.result(loadDurably(State, key).pipe(Effect.provideService(StoragePort, malformedStorage)))
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('SaveDecodeError')
          expect(result.failure.message).toContain('well-formed save envelope')
        }
      }),
    )

    effect('SaveDecodeError + no previous checkpoint: fails with the latest error', () =>
      Effect.gen(function* () {
        const storage = yield* makeInMemoryStorage
        const badSchema = sealEnvelopeForTest(saveEnvelope(State.name, State.version, { score: 'nope', label: 'bad' }))
        yield* storage.put(key, badSchema)

        const result = yield* Effect.result(loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage)))
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('SaveDecodeError')
          expect(result.failure.message).toContain('current schema')
        }
      }),
    )

  })
})

describe('save integrity', () => {
  it('compares supported envelopes by their canonical content', () => {
    const isSame = (left: SaveEnvelope, right: SaveEnvelope): boolean =>
      Result.getOrThrow(sameSaveEnvelope(left, right))

    const ordered = sealEnvelopeForTest(saveEnvelope(State.name, 1, {
      nested: { first: 1, second: [true, null] },
      bytes: new Uint8Array([1, 2]),
    }))
    const reordered = sealEnvelopeForTest(saveEnvelope(State.name, 1, {
      bytes: { '0': 1, '1': 2 },
      nested: { second: [true, null], first: 1 },
    }))
    expect(isSame(ordered, reordered)).toBe(true)
    expect(isSame(ordered, { ...reordered, version: Result.getOrThrow(SaveFormatVersion.result(2)) })).toBe(false)
    expect(isSame(ordered, { ...reordered, payload: { different: true } })).toBe(false)
    expect(isSame({ ...ordered, payload: { left: 1 } }, { ...ordered, payload: { right: 1 } })).toBe(false)
    expect(isSame(ordered, { ...reordered, payload: 'different' })).toBe(false)
    expect(
      Result.isFailure(sameSaveEnvelope({ ...ordered, payload: null }, { ...ordered, payload: Number.POSITIVE_INFINITY })),
    ).toBe(true)
    expect(
      Result.isFailure(sameSaveEnvelope({ ...ordered, payload: Number.NaN }, { ...ordered, payload: Number.NEGATIVE_INFINITY })),
    ).toBe(true)

    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const sparse = new Array(1)
    const symbols = { [Symbol('private')]: true }
    const functionValue = () => undefined
    const throwingEnvelope = widen<Parameters<typeof sameSaveEnvelope>[0]>(
      Object.defineProperty({}, 'format', {
        get: () => {
          throw new Error('format getter failed')
        },
      }),
    )
    expect(Result.isFailure(sameSaveEnvelope(ordered, { ...ordered, payload: cyclic }))).toBe(true)
    expect(Result.isFailure(sameSaveEnvelope({ ...ordered, payload: cyclic }, { ...ordered, payload: cyclic }))).toBe(true)
    expect(Result.isFailure(sameSaveEnvelope(ordered, { ...ordered, payload: sparse }))).toBe(true)
    expect(isSame({ ...ordered, payload: [1] }, { ...ordered, payload: [1, 2] })).toBe(false)
    expect(isSame({ ...ordered, payload: [[1]] }, { ...ordered, payload: [[2]] })).toBe(false)
    expect(Result.isFailure(sameSaveEnvelope(ordered, { ...ordered, payload: symbols }))).toBe(true)
    expect(Result.isFailure(sameSaveEnvelope({ ...ordered, payload: symbols }, ordered))).toBe(true)
    expect(Result.isFailure(sameSaveEnvelope(ordered, { ...ordered, payload: new Date() }))).toBe(true)
    expect(Result.isFailure(sameSaveEnvelope({ ...ordered, payload: new Date() }, ordered))).toBe(true)
    expect(Result.isFailure(sameSaveEnvelope(ordered, { ...ordered, payload: undefined }))).toBe(true)
    expect(
      Result.isFailure(
        sameSaveEnvelope({ ...ordered, payload: functionValue }, { ...ordered, payload: functionValue }),
      ),
    ).toBe(true)
    expect(isSame(reordered, ordered)).toBe(true)
    expect(Result.isFailure(sameSaveEnvelope(throwingEnvelope, ordered))).toBe(true)
  })

  it('is deterministic across object insertion order and repeated round trips', () => {
    for (let index = 0; index < 100; index += 1) {
      const left = sealEnvelopeForTest(saveEnvelope(State.name, 1, { a: index, b: `value-${String(index)}` }))
      const right = sealEnvelopeForTest(saveEnvelope(State.name, 1, { b: `value-${String(index)}`, a: index }))
      expect(left.integrity).toStrictEqual(right.integrity)
      expect(sealEnvelopeForTest(left).integrity).toStrictEqual(left.integrity)
    }
  })

  effect('uses canonical UTF-8 bytes for multi-byte payloads', () =>
    Effect.gen(function* () {
      const sealed = sealEnvelopeForTest(saveEnvelope(State.name, 1, { score: 1, label: 'é漢🦊' }))
      expect(sealed.integrity).toStrictEqual({ algorithm: 'fnv1a32', byteLength: 87, checksum: '08574854' })
      expect(yield* validateSaveEnvelope(sealed)).toStrictEqual(sealed)
    }),
  )

  effect('rejects an unsealed draft before it can be treated as valid', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(validateSaveEnvelope(saveEnvelope(State.name, 1, { score: 1, label: 'draft' })))
      expect(error.reason).toContain('checksum')
    }),
  )

  effect('sanitizes malformed format and version fields and rejects altered content', () =>
    Effect.gen(function* () {
      const sealed = sealEnvelopeForTest(saveEnvelope(State.name, 1, { score: 1, label: 'sealed' }))
      const malformedScalars = widen<SaveEnvelope>({
        ...sealed,
        format: 42,
        version: Number.POSITIVE_INFINITY,
      })
      const scalarError = yield* Effect.flip(validateSaveEnvelope(malformedScalars))
      expect(scalarError.format).toBe('unknown')
      expect(scalarError.version).toBe(0)

      const changedChecksum = widen<SaveEnvelope>({
        ...sealed,
        integrity: { ...sealed.integrity, checksum: '00000000' },
      })
      const sealMismatch = sealSaveEnvelopeResult(changedChecksum)
      expect(Result.isFailure(sealMismatch)).toBe(true)
      const validationMismatch = yield* Effect.flip(validateSaveEnvelope(changedChecksum))
      expect(validationMismatch.reason).toContain('checksum')

      const changedLength = widen<SaveEnvelope>({
        ...sealed,
        integrity: { ...sealed.integrity, byteLength: sealed.integrity.byteLength + 1 },
      })
      expect((yield* Effect.result(validateSaveEnvelope(changedLength)))._tag).toBe('Failure')

      const unsupportedPayload = widen<SaveEnvelope>({ ...sealed, payload: new Date() })
      const unsupportedError = yield* Effect.flip(validateSaveEnvelope(unsupportedPayload))
      expect(unsupportedError.reason).toContain('unsupported value')
    }),
  )

  effect('rejects an unknown or malformed integrity record', () =>
    Effect.gen(function* () {
      const sealed = sealEnvelopeForTest(saveEnvelope(State.name, 1, { score: 1, label: 'sealed' }))
      const malformedIntegrity = [
        null,
        [],
        { ...sealed.integrity, algorithm: 'sha256' },
        { ...sealed.integrity, byteLength: '1' },
        { ...sealed.integrity, byteLength: Number.MAX_SAFE_INTEGER + 1 },
        { ...sealed.integrity, byteLength: -1 },
        { ...sealed.integrity, checksum: 42 },
        { ...sealed.integrity, checksum: 'not-a-checksum' },
      ]
      for (const integrity of malformedIntegrity) {
        const candidate = widen<SaveEnvelope>({ ...sealed, integrity })
        expect((yield* Effect.result(validateSaveEnvelope(candidate)))._tag).toBe('Failure')
      }

      const malformedOuter = widen<SaveEnvelope>(null)
      const outerError = yield* Effect.flip(validateSaveEnvelope(malformedOuter))
      expect(outerError.reason).toBe('save envelope must be an object')

      const malformedExtensions = widen<SaveEnvelope>({ ...sealed, extensions: new Date() })
      const extensionError = yield* Effect.flip(validateSaveEnvelope(malformedExtensions))
      expect(extensionError.reason).toBe('save envelope extensions must be a plain string-keyed object')

      const unreadableExtensions = new Proxy({ note: 'value' }, {
        get: (_target, _property, _receiver) => { throw new Error('extension value could not be read') },
      })
      const unreadableExtensionsCandidate = widen<SaveEnvelope>({ ...sealed, extensions: unreadableExtensions })
      const unreadableExtensionsError = yield* Effect.flip(validateSaveEnvelope(unreadableExtensionsCandidate))
      expect(unreadableExtensionsError.reason).toBe('save envelope extensions could not be read')

      const getterFailure = new Error('integrity getter failed')
      const throwingIntegrity = new Proxy(sealed.integrity, {
        get: (target, property, receiver) => {
          if (property === 'checksum') throw getterFailure
          return Reflect.get(target, property, receiver)
        },
      })
      const throwingCandidate = { ...sealed, integrity: throwingIntegrity }
      const result = yield* Effect.result(validateSaveEnvelope(throwingCandidate))
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('SaveDecodeError')
        expect(result.failure.cause).toBe(getterFailure)
      }
    }),
  )

  effect('reports a non-finite untrusted payload before comparing its integrity metadata', () =>
    Effect.gen(function* () {
      const malformed = widen<SaveEnvelope>({
        format: State.name,
        version: 1,
        payload: { score: Number.POSITIVE_INFINITY },
        integrity: { algorithm: 'fnv1a32', byteLength: 0, checksum: '00000000' },
      })

      const error = yield* Effect.flip(validateSaveEnvelope(malformed))

      expect(error._tag).toBe('SaveDecodeError')
      expect(error.reason).toBe('save contains a non-finite number')
    }),
  )

  effect('rejects non-finite values and saves above the configured byte limit', () =>
    Effect.gen(function* () {
      const nonFiniteDraft = saveEnvelope(State.name, 1, { score: Number.NaN })
      const nonFinite = sealSaveEnvelopeResult(nonFiniteDraft)
      expect(Result.isFailure(nonFinite)).toBe(true)
      if (Result.isFailure(nonFinite)) {
        expect(nonFinite.failure._tag).toBe('SaveDecodeError')
        expect(nonFinite.failure.reason).toBe('save contains a non-finite number')
      }

      const sealingNonFinite = yield* Effect.flip(
        sealAndValidateSaveEnvelope(nonFiniteDraft, undefined, DEFAULT_MAX_SAVE_BYTES),
      )
      expect(sealingNonFinite.reason).toBe('save contains a non-finite number')

      const oversized = sealEnvelopeForTest(saveEnvelope(State.name, 1, { text: 'too large' }))
      expect((yield* Effect.result(validateSaveEnvelope(oversized, SaveMaxBytes(1))))._tag).toBe('Failure')

      const sealingOversize = yield* Effect.flip(
        sealAndValidateSaveEnvelope(oversized, undefined, SaveMaxBytes(1)),
      )
      expect(sealingOversize.reason).toContain('save exceeds the 1 byte limit')

      const invalidValidationBudget = yield* Effect.flip(
        validateSaveEnvelope(oversized, widen<SaveMaxBytes>(Number.NaN)),
      )
      expect(invalidValidationBudget.reason).toContain('maxBytes must be a non-negative safe integer')

      const invalidSealingBudget = yield* Effect.flip(
        sealAndValidateSaveEnvelope(oversized, undefined, widen<SaveMaxBytes>(-1)),
      )
      expect(invalidSealingBudget.reason).toContain('maxBytes must be a non-negative safe integer')
    }),
  )

  effect('seals its own extensions argument in and rejects unsupported values', () =>
    Effect.gen(function* () {
      const withExtensions = sealEnvelopeForTest(saveEnvelope(State.name, 1, { score: 1, label: 'x' }), {
        note: 'manual-seal',
      })

      expect(withExtensions.extensions).toStrictEqual({ note: 'manual-seal' })
      expect(yield* validateSaveEnvelope(withExtensions)).toStrictEqual(withExtensions)

      const cyclic: { self?: unknown } = {}
      cyclic.self = cyclic
      const sparse: Array<unknown> = []
      sparse[1] = 'value'

      const failures = [
        [saveEnvelope(State.name, 1, undefined), 'save envelope draft is malformed'],
        [saveEnvelope(State.name, 1, cyclic), 'cyclic data'],
        [saveEnvelope(State.name, 1, new Date()), 'only plain objects and Uint8Array values are supported'],
        [saveEnvelope(State.name, 1, sparse), 'sparse arrays and custom array properties are not supported'],
        [saveEnvelope(State.name, 1, [undefined]), 'unsupported value: undefined'],
        [saveEnvelope(State.name, 1, { [Symbol('private')]: 'value' }), 'symbol-keyed object properties are not supported'],
      ] as const
      for (const [envelope, reason] of failures) {
        const sealed = sealSaveEnvelopeResult(envelope)
        expect(Result.isFailure(sealed)).toBe(true)
        if (Result.isFailure(sealed)) {
          expect(sealed.failure._tag).toBe('SaveDecodeError')
          expect(sealed.failure.reason).toContain(reason)
        }
      }

      const invalidExtensions: ReadonlyArray<unknown> = [
        [],
        new Date(),
        { [Symbol('private')]: 'value' },
        new Proxy({}, {
          ownKeys: () => {
            throw new Error('extension keys could not be read')
          },
        }),
      ]
      for (const extensions of invalidExtensions) {
        const result = sealSaveEnvelopeResult(
          saveEnvelope(State.name, 1, { score: 1, label: 'x' }),
          widen<Readonly<Record<string, unknown>>>(extensions),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe('SaveDecodeError')
        }
      }
    }),
  )

  effect('returns a SaveDecodeError after reading a malformed envelope getter once', () =>
    Effect.sync(() => {
      const getterFailure = new Error('format getter failed')
      let reads = 0
      const malformed = new Proxy(saveEnvelope(State.name, 1, { score: 1, label: 'x' }), {
        get: (target, property, receiver) => {
          if (property === 'format') {
            reads += 1
            throw getterFailure
          }
          return Reflect.get(target, property, receiver)
        },
      })

      const result = sealSaveEnvelopeResult(malformed)
      expect(reads).toBe(1)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('SaveDecodeError')
        expect(result.failure.cause).toBe(getterFailure)
      }
    }),
  )

  effect('rejects malformed typed-array proxy elements and normalizes property failures', () =>
    Effect.sync(() => {
      const malformedBytes = new Proxy(new Uint8Array([1]), {
        get: (target, property, receiver) =>
          property === '0' ? Symbol('not a byte') : Reflect.get(target, property, receiver),
      })
      const byteResult = canonicalize(malformedBytes)
      expect(Result.isFailure(byteResult)).toBe(true)
      if (Result.isFailure(byteResult)) expect(byteResult.failure).toContain('symbol')

      const error = new Error('property getter failed')
      const errorValue = Object.defineProperty({}, 'value', {
        enumerable: true,
        get: () => { throw error },
      })
      const errorResult = canonicalize(errorValue)
      expect(Result.isFailure(errorResult)).toBe(true)
      if (Result.isFailure(errorResult)) expect(errorResult.failure).toContain(error.message)

      const nonErrorValue = Object.defineProperty({}, 'value', {
        enumerable: true,
        get: () => {
          // oxlint-disable-next-line no-throw-literal -- deliberate non-Error throw to test canonicalize's unknown-cause handling.
          throw 'not an Error'
        },
      })
      const nonErrorResult = canonicalize(nonErrorValue)
      expect(Result.isFailure(nonErrorResult)).toBe(true)
      if (Result.isFailure(nonErrorResult)) expect(nonErrorResult.failure).toContain('a property could not be read')
    }),
  )

  effect('canonicalizes Uint8Array payloads consistently', () =>
    Effect.gen(function* () {
      const sealed = sealEnvelopeForTest(saveEnvelope(State.name, 1, new Uint8Array([1, 2, 255])))

      expect(sealed.integrity.byteLength).toBeGreaterThan(0)
      expect(yield* validateSaveEnvelope(sealed)).toStrictEqual(sealed)
    }),
  )

  effect('normalizes non-Error canonicalization failures into decode errors', () =>
    Effect.gen(function* () {
      const throwingPayload = new Proxy(
        {},
        {
          ownKeys: () => {
            throw Object.create(null)
          },
        },
      )
      const envelope = saveEnvelope(State.name, 1, throwingPayload)

      const validationError = yield* Effect.flip(validateSaveEnvelope(envelope))
      expect(validationError.reason).toContain('save contains an unsupported value')

      const sealingError = yield* Effect.flip(
        sealAndValidateSaveEnvelope(envelope, undefined, DEFAULT_MAX_SAVE_BYTES),
      )
      expect(sealingError.reason).toContain('save contains an unsupported value')

      const unsupportedEnvelope = saveEnvelope(State.name, 1, new Date())
      const unsupportedValidation = yield* Effect.flip(validateSaveEnvelope(unsupportedEnvelope))
      expect(unsupportedValidation.reason).toContain('only plain objects')

      const unsupportedSealing = yield* Effect.flip(
        sealAndValidateSaveEnvelope(unsupportedEnvelope, undefined, DEFAULT_MAX_SAVE_BYTES),
      )
      expect(unsupportedSealing.reason).toContain('only plain objects')
    }),
  )
})
