import { describe, expect, it } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Option, Schema } from 'effect'
import {
  loadDurably,
  saveDurably,
  sealSaveEnvelope,
  validateSaveEnvelope,
} from '../src/domain/durable-save.js'
import { saveEnvelope, type SaveEnvelope } from '../src/domain/envelope.js'
import { StorageError } from '../src/domain/errors.js'
import { defineFormat } from '../src/domain/format.js'
import { DEFAULT_MAX_SAVE_BYTES, sameSaveEnvelope, sealAndValidateSaveEnvelope } from '../src/domain/integrity.js'
import { makeInMemoryStorage, SaveKey, StoragePort } from '../src/domain/storage-port.js'

// Widens a value's static type to `T` with NO runtime transformation and no type assertion:
// `Record<string, any>` indexing is `any` by construction, assignable anywhere with zero compiler
// complaint. Used to construct a deliberately invalid/malformed envelope so a test proves runtime
// validation — not the type checker — rejects it.
const widen = <T,>(value: unknown): T => {
  const bag: Record<string, any> = {}
  bag['value'] = value
  return bag['value']
}

const State = defineFormat({
  name: 'mc-save/test/durable',
  version: 1,
  schema: Schema.Struct({ score: Schema.Number, label: Schema.String }),
})

const CompleteWorld = defineFormat({
  name: 'mc-save/test/complete-world',
  version: 1,
  schema: Schema.Struct({
    dimension: Schema.String,
    player: Schema.Struct({
      id: Schema.String,
      position: Schema.Tuple(Schema.Number, Schema.Number, Schema.Number),
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
      const maxBytes = DEFAULT_MAX_SAVE_BYTES + 1_024
      const value = { score: 1, label: 'x'.repeat(DEFAULT_MAX_SAVE_BYTES) }
      const envelope = sealSaveEnvelope(saveEnvelope(State.name, State.version, value))
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
      yield* storage.put(key, sealSaveEnvelope(saveEnvelope(State.name, State.version + 1, { score: 3, label: 'future' })))

      const result = yield* Effect.either(loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage)))
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toMatchObject({ _tag: 'SaveDecodeError', version: State.version + 1 })
        expect(result.left.message).toContain('newer build')
      }
    }),
  )

  effect('does not overwrite a valid checkpoint from a newer build', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      const previous = yield* storage.get(previousKey)
      const future = sealSaveEnvelope(saveEnvelope(State.name, State.version + 1, { score: 3, label: 'future' }))
      yield* storage.put(key, future)

      const result = yield* Effect.either(
        saveDurably(State, key, { score: 4, label: 'replacement' }).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toMatchObject({ _tag: 'SaveDecodeError', version: State.version + 1 })
        expect(result.left.message).toContain('newer build')
      }
      expect(yield* storage.get(key)).toStrictEqual(Option.some(future))
      expect(yield* storage.get(previousKey)).toStrictEqual(previous)
    }),
  )

  effect('does not replace a good previous checkpoint with a corrupt latest', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      const latest = yield* storage.get(key)
      if (Option.isNone(latest)) throw new Error('latest checkpoint was not written')
      yield* storage.put(key, { ...latest.value, integrity: { ...latest.value.integrity, checksum: '00000000' } })

      yield* saveDurably(State, key, { score: 3, label: 'third' }).pipe(Effect.provideService(StoragePort, storage))
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

      const failure = yield* Effect.either(
        saveDurably(State, key, { score: 2, label: 'lost' }).pipe(Effect.provideService(StoragePort, interrupted)),
      )
      expect(failure._tag).toBe('Left')
      expect(yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage))).toStrictEqual(
        Option.some({ score: 1, label: 'stable' }),
      )
    }),
  )

  effect('retains opaque extensions across later checkpoints', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      const extensions = { futureInventory: { slots: [1, 2, 3] } }
      yield* saveDurably(State, key, { score: 1, label: 'first' }, { extensions }).pipe(
        Effect.provideService(StoragePort, storage),
      )
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))

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
            yield* Effect.async<void>((resume) => {
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
            yield* Effect.async<void>((resume) => {
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
      yield* storage.put(key, draft)

      const result = yield* Effect.either(loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage)))
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('SaveDecodeError')
        if (result.left._tag === 'SaveDecodeError') expect(result.left.reason).toContain('well-formed')
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

      const result = yield* Effect.either(
        saveDurably(State, key, { score: Number.NaN, label: 'x' }).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('SaveDecodeError')
        if (result.left._tag === 'SaveDecodeError') {
          expect(result.left.reason).toBe('save contains a non-finite number')
        }
      }
      expect(yield* storage.get(key)).toStrictEqual(Option.none())
    }),
  )

  effect('refuses to write a value whose sealed envelope exceeds the configured byte limit', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage

      const result = yield* Effect.either(
        saveDurably(State, key, { score: 1, label: 'this label is long enough to blow a tiny byte budget' }, {
          maxBytes: 8,
        }).pipe(Effect.provideService(StoragePort, storage)),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('SaveDecodeError')
        if (result.left._tag === 'SaveDecodeError') {
          expect(result.left.reason).toContain('byte limit')
        }
      }
      expect(yield* storage.get(key)).toStrictEqual(Option.none())
    }),
  )

  effect('does not carry forward a latest that parses but fails to decode (SaveDecodeError, non-future)', () =>
    Effect.gen(function* () {
      // Distinct from `loadDurably`'s own fallback block: this is
      // `saveDurably`'s `recoverableCheckpoint`, which decides whether the
      // EXISTING latest is worth keeping as the new `previous` before writing.
      // A latest that parses and passes its checksum but fails to decode is
      // "not good", the same as a corrupt or missing one, but by a different
      // path through the code.
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))

      const badSchema = sealSaveEnvelope(saveEnvelope(State.name, State.version, { score: 'nope', label: 'bad' }))
      yield* storage.put(key, badSchema)

      yield* saveDurably(State, key, { score: 3, label: 'third' }).pipe(Effect.provideService(StoragePort, storage))

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
        const badSchema = sealSaveEnvelope(saveEnvelope(State.name, State.version, { score: 'nope', label: 'bad' }))
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
        // `SaveEnvelope`. `Effect.either(readStoredEnvelope(...))` comes back
        // `Left` directly, so `loadDurably` never reaches its
        // `Effect.catchTags` block at all for this one.
        const storage = yield* makeInMemoryStorage
        yield* storage.put(key, widen<SaveEnvelope>({ format: '', version: 0, payload: null }))

        const result = yield* Effect.either(loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage)))
        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') {
          expect(result.left._tag).toBe('SaveDecodeError')
          expect(result.left.message).toContain('well-formed save envelope')
        }
      }),
    )

    effect('SaveDecodeError + no previous checkpoint: fails with the latest error', () =>
      Effect.gen(function* () {
        const storage = yield* makeInMemoryStorage
        const badSchema = sealSaveEnvelope(saveEnvelope(State.name, State.version, { score: 'nope', label: 'bad' }))
        yield* storage.put(key, badSchema)

        const result = yield* Effect.either(loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage)))
        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') {
          expect(result.left._tag).toBe('SaveDecodeError')
          expect(result.left.message).toContain('current schema')
        }
      }),
    )

  })
})

describe('save integrity', () => {
  it('compares supported envelopes by their canonical content', () => {
    const ordered = sealSaveEnvelope(saveEnvelope(State.name, 1, {
      nested: { first: 1, second: [true, null] },
      bytes: new Uint8Array([1, 2]),
    }))
    const reordered = sealSaveEnvelope(saveEnvelope(State.name, 1, {
      bytes: { '0': 1, '1': 2 },
      nested: { second: [true, null], first: 1 },
    }))
    expect(sameSaveEnvelope(ordered, reordered)).toBe(true)
    expect(sameSaveEnvelope(ordered, { ...reordered, version: 2 })).toBe(false)
    expect(sameSaveEnvelope(ordered, { ...reordered, payload: { different: true } })).toBe(false)
    expect(sameSaveEnvelope({ ...ordered, payload: { left: 1 } }, { ...ordered, payload: { right: 1 } })).toBe(false)
    expect(sameSaveEnvelope(ordered, { ...reordered, payload: 'different' })).toBe(false)
    expect(sameSaveEnvelope({ ...ordered, payload: null }, { ...ordered, payload: Number.POSITIVE_INFINITY })).toBe(true)
    expect(sameSaveEnvelope({ ...ordered, payload: Number.NaN }, { ...ordered, payload: Number.NEGATIVE_INFINITY })).toBe(true)

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
    expect(sameSaveEnvelope(ordered, { ...ordered, payload: cyclic })).toBe(false)
    expect(sameSaveEnvelope({ ...ordered, payload: cyclic }, { ...ordered, payload: cyclic })).toBe(false)
    expect(sameSaveEnvelope(ordered, { ...ordered, payload: sparse })).toBe(false)
    expect(sameSaveEnvelope({ ...ordered, payload: [1] }, { ...ordered, payload: [1, 2] })).toBe(false)
    expect(sameSaveEnvelope({ ...ordered, payload: [[1]] }, { ...ordered, payload: [[2]] })).toBe(false)
    expect(sameSaveEnvelope(ordered, { ...ordered, payload: symbols })).toBe(false)
    expect(sameSaveEnvelope({ ...ordered, payload: symbols }, ordered)).toBe(false)
    expect(sameSaveEnvelope(ordered, { ...ordered, payload: new Date() })).toBe(false)
    expect(sameSaveEnvelope({ ...ordered, payload: new Date() }, ordered)).toBe(false)
    expect(sameSaveEnvelope(ordered, { ...ordered, payload: undefined })).toBe(false)
    expect(sameSaveEnvelope({ ...ordered, payload: functionValue }, { ...ordered, payload: functionValue })).toBe(false)
    expect(sameSaveEnvelope(reordered, ordered)).toBe(true)
    expect(sameSaveEnvelope(throwingEnvelope, ordered)).toBe(false)
  })

  it('is deterministic across object insertion order and repeated round trips', () => {
    for (let index = 0; index < 100; index += 1) {
      const left = sealSaveEnvelope(saveEnvelope(State.name, 1, { a: index, b: `value-${String(index)}` }))
      const right = sealSaveEnvelope(saveEnvelope(State.name, 1, { b: `value-${String(index)}`, a: index }))
      expect(left.integrity).toStrictEqual(right.integrity)
      expect(sealSaveEnvelope(left).integrity).toStrictEqual(left.integrity)
    }
  })

  effect('uses canonical UTF-8 bytes for multi-byte payloads', () =>
    Effect.gen(function* () {
      const sealed = sealSaveEnvelope(saveEnvelope(State.name, 1, { score: 1, label: 'é漢🦊' }))
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

  effect('rejects an unknown or malformed integrity record', () =>
    Effect.gen(function* () {
      const sealed = sealSaveEnvelope(saveEnvelope(State.name, 1, { score: 1, label: 'sealed' }))
      const unknownAlgorithm = widen<SaveEnvelope>({
        ...sealed,
        integrity: { ...sealed.integrity, algorithm: 'sha256' },
      })
      const malformed = widen<SaveEnvelope>({ ...sealed, integrity: null })

      expect((yield* Effect.either(validateSaveEnvelope(unknownAlgorithm)))._tag).toBe('Left')
      expect((yield* Effect.either(validateSaveEnvelope(malformed)))._tag).toBe('Left')
    }),
  )

  effect('rejects non-finite values and saves above the configured byte limit', () =>
    Effect.gen(function* () {
      const nonFinite = sealSaveEnvelope(saveEnvelope(State.name, 1, { score: Number.NaN }))
      expect((yield* Effect.either(validateSaveEnvelope(nonFinite)))._tag).toBe('Left')

      const sealingNonFinite = yield* Effect.flip(
        sealAndValidateSaveEnvelope(nonFinite, undefined, DEFAULT_MAX_SAVE_BYTES),
      )
      expect(sealingNonFinite.reason).toBe('save contains a non-finite number')

      const oversized = sealSaveEnvelope(saveEnvelope(State.name, 1, { text: 'too large' }))
      expect((yield* Effect.either(validateSaveEnvelope(oversized, 1)))._tag).toBe('Left')

      const sealingOversize = yield* Effect.flip(sealAndValidateSaveEnvelope(oversized, undefined, 1))
      expect(sealingOversize.reason).toContain('save exceeds the 1 byte limit')

      const invalidValidationBudget = yield* Effect.flip(validateSaveEnvelope(oversized, Number.NaN))
      expect(invalidValidationBudget.reason).toContain('maxBytes must be a non-negative safe integer')

      const invalidSealingBudget = yield* Effect.flip(
        sealAndValidateSaveEnvelope(oversized, undefined, -1),
      )
      expect(invalidSealingBudget.reason).toContain('maxBytes must be a non-negative safe integer')
    }),
  )

  effect('seals its own extensions argument in and rejects unsupported values', () =>
    Effect.gen(function* () {
      // `sealSaveEnvelope`'s own `extensions` parameter, as opposed to
      // `saveDurably`'s inherited-extensions plumbing exercised elsewhere: a
      // direct caller can attach extensions at seal time too.
      const withExtensions = sealSaveEnvelope(saveEnvelope(State.name, 1, { score: 1, label: 'x' }), {
        note: 'manual-seal',
      })

      expect(withExtensions.extensions).toStrictEqual({ note: 'manual-seal' })
      expect(yield* validateSaveEnvelope(withExtensions)).toStrictEqual(withExtensions)

      const cyclic: { self?: unknown } = {}
      cyclic.self = cyclic
      const sparse: Array<unknown> = []
      sparse[1] = 'value'

      expect(() => sealSaveEnvelope(saveEnvelope(State.name, 1, undefined))).toThrow('undefined')
      expect(() => sealSaveEnvelope(saveEnvelope(State.name, 1, cyclic))).toThrow('cyclic data')
      expect(() => sealSaveEnvelope(saveEnvelope(State.name, 1, new Date()))).toThrow(
        'only plain objects and Uint8Array values are supported',
      )
      expect(() => sealSaveEnvelope(saveEnvelope(State.name, 1, sparse))).toThrow(
        'sparse arrays and custom array properties are not supported',
      )
      expect(() =>
        sealSaveEnvelope(saveEnvelope(State.name, 1, { [Symbol('private')]: 'value' })),
      ).toThrow('symbol-keyed object properties are not supported')
    }),
  )

  effect('canonicalizes Uint8Array payloads consistently', () =>
    Effect.gen(function* () {
      const sealed = sealSaveEnvelope(saveEnvelope(State.name, 1, new Uint8Array([1, 2, 255])))

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
      expect(validationError.reason).toBe('save contains an unsupported value')

      const sealingError = yield* Effect.flip(
        sealAndValidateSaveEnvelope(envelope, undefined, DEFAULT_MAX_SAVE_BYTES),
      )
      expect(sealingError.reason).toBe('save contains an unsupported value')

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
