import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import {
  loadDurably,
  saveDurably,
  sealSaveEnvelope,
  validateSaveEnvelope,
} from '../src/domain/durable-save'
import { saveEnvelope } from '../src/domain/envelope'
import { StorageError } from '../src/domain/errors'
import { defineFormat, type Migration } from '../src/domain/format'
import { makeInMemoryStorage, SaveKey, StoragePort } from '../src/domain/storage-port'

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
  it.effect('falls back to the previous known-good checkpoint when latest is corrupt', () =>
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

  it.effect('falls back to the previous known-good checkpoint when latest is missing', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      yield* storage.remove(key)

      const restored = yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage))
      expect(restored).toStrictEqual(Option.some({ score: 1, label: 'first' }))
    }),
  )

  it.effect('does not fall back when latest is a valid checkpoint from a newer build', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      yield* storage.put(key, saveEnvelope(State.name, State.version + 1, { score: 3, label: 'future' }))

      const result = yield* Effect.either(loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage)))
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toMatchObject({ _tag: 'SaveDecodeError', version: State.version + 1 })
        expect(result.left.message).toContain('newer build')
      }
    }),
  )

  it.effect('does not overwrite a valid checkpoint from a newer build', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      const previous = yield* storage.get(previousKey)
      const future = saveEnvelope(State.name, State.version + 1, { score: 3, label: 'future' })
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

  it.effect('does not replace a good previous checkpoint with a corrupt latest', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(State, key, { score: 2, label: 'second' }).pipe(Effect.provideService(StoragePort, storage))
      const latest = yield* storage.get(key)
      if (Option.isNone(latest)) throw new Error('latest checkpoint was not written')
      yield* storage.put(key, { ...latest.value, integrity: { ...latest.value.integrity!, checksum: '00000000' } })

      yield* saveDurably(State, key, { score: 3, label: 'third' }).pipe(Effect.provideService(StoragePort, storage))
      const previous = yield* storage.get(previousKey)
      expect(Option.isSome(previous) && previous.value.payload).toStrictEqual({ score: 1, label: 'first' })
    }),
  )

  it.effect('keeps the existing checkpoint when the atomic commit is interrupted', () =>
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

  it.effect('retains opaque extensions across later checkpoints', () =>
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

  it.effect('does not decode the previous checkpoint when latest is healthy', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* saveDurably(State, key, { score: 1, label: 'previous' }).pipe(
        Effect.provideService(StoragePort, storage),
      )
      yield* saveDurably(State, key, { score: 2, label: 'latest' }).pipe(
        Effect.provideService(StoragePort, storage),
      )

      const inaccessiblePayload = Object.defineProperty({}, 'score', {
        get: () => {
          throw new Error('the previous payload was needlessly decoded')
        },
      })
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

  it.effect('serializes concurrent checkpoints for the same world', () =>
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

  it.effect('round-trips dimension, player, entity, vehicle, and boss state', () =>
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

  it.effect('loads legacy envelopes without integrity metadata', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      yield* storage.put(key, saveEnvelope(State.name, 1, { score: 7, label: 'legacy' }))
      expect(yield* loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage))).toStrictEqual(
        Option.some({ score: 7, label: 'legacy' }),
      )
    }),
  )

  it.effect('treats a key that was never written as a new world, not an error', () =>
    Effect.gen(function* () {
      const storage = yield* makeInMemoryStorage
      expect(
        yield* loadDurably(State, SaveKey('never-written')).pipe(Effect.provideService(StoragePort, storage)),
      ).toStrictEqual(Option.none())
    }),
  )

  it.effect('refuses to write a value that seals to a non-finite number, before anything is stored', () =>
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

  it.effect('refuses to write a value whose sealed envelope exceeds the configured byte limit', () =>
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

  it.effect('does not carry forward a latest that parses but fails to decode (SaveDecodeError, non-future)', () =>
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

  it.effect('does not carry forward a latest that parses but fails to decode (MigrationError)', () =>
    Effect.gen(function* () {
      const alwaysFailsMigration: Migration = {
        from: 1,
        describe: 'deliberately fails, to exercise recoverableCheckpoint’s MigrationError arm',
        migrate: () => Effect.fail('boom'),
      }
      const Migrating = defineFormat({
        name: 'mc-save/test/migrating-on-save',
        version: 2,
        schema: Schema.Struct({ value: Schema.String }),
        migrations: [alwaysFailsMigration],
      })
      const migratingKey = SaveKey('world-migrating-on-save')
      const migratingPreviousKey = SaveKey('world-migrating-on-save::previous')

      const storage = yield* makeInMemoryStorage
      yield* saveDurably(Migrating, migratingKey, { value: 'first' }).pipe(Effect.provideService(StoragePort, storage))
      yield* saveDurably(Migrating, migratingKey, { value: 'second' }).pipe(Effect.provideService(StoragePort, storage))

      // A v1 envelope: decoding it must migrate first, and the v1 → v2 step
      // always fails, so this is "not good" via MigrationError rather than
      // SaveDecodeError.
      const migrationFails = sealSaveEnvelope(saveEnvelope(Migrating.name, 1, { value: 'irrelevant' }))
      yield* storage.put(migratingKey, migrationFails)

      yield* saveDurably(Migrating, migratingKey, { value: 'third' }).pipe(Effect.provideService(StoragePort, storage))

      const previous = yield* storage.get(migratingPreviousKey)
      expect(Option.isSome(previous) && previous.value.payload).toStrictEqual({ value: 'first' })
    }),
  )

  /**
   * The four fallback branches of `loadDurably`'s `Effect.catchTags` block:
   * `latest` parses as a well-formed, integrity-valid envelope (so it clears
   * `readStoredEnvelope`, unlike the "corrupt"/"missing" cases above, which
   * fail earlier) but `decodeSave` itself then rejects it — either because the
   * payload does not satisfy the current schema (`SaveDecodeError`) or because
   * a migration step fails (`MigrationError`) — crossed with whether a
   * `previous` checkpoint exists to fall back to.
   */
  describe('falling back past a latest that parses but does not decode', () => {
    it.effect('SaveDecodeError + a previous checkpoint: falls back to previous', () =>
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

    it.effect('latest is not even a well-formed envelope, and there is no previous: fails with that error', () =>
      Effect.gen(function* () {
        // One level earlier than the two cases above: this fails inside
        // `readStoredEnvelope` itself (line ~200), before `decodeSave` is ever
        // reached, because the stored value cannot even be parsed as a
        // `SaveEnvelope`. `Effect.either(readStoredEnvelope(...))` comes back
        // `Left` directly, so `loadDurably` never reaches its
        // `Effect.catchTags` block at all for this one.
        const storage = yield* makeInMemoryStorage
        yield* storage.put(key, { format: '', version: 0, payload: null })

        const result = yield* Effect.either(loadDurably(State, key).pipe(Effect.provideService(StoragePort, storage)))
        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') {
          expect(result.left._tag).toBe('SaveDecodeError')
          expect(result.left.message).toContain('well-formed save envelope')
        }
      }),
    )

    it.effect('SaveDecodeError + no previous checkpoint: fails with the latest error', () =>
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

    const alwaysFailsMigration: Migration = {
      from: 1,
      describe: 'deliberately fails, to exercise the MigrationError fallback',
      migrate: () => Effect.fail('boom'),
    }
    const Migrating = defineFormat({
      name: 'mc-save/test/migrating',
      version: 2,
      schema: Schema.Struct({ value: Schema.String }),
      migrations: [alwaysFailsMigration],
    })
    const migratingKey = SaveKey('world-migrating')
    const migratingPreviousKey = SaveKey('world-migrating::previous')

    it.effect('MigrationError + a previous checkpoint: falls back to previous', () =>
      Effect.gen(function* () {
        const storage = yield* makeInMemoryStorage
        const good = sealSaveEnvelope(saveEnvelope(Migrating.name, Migrating.version, { value: 'good' }))
        // A v1 envelope: `decodeSave` must migrate before it can decode, and the
        // v1 → v2 step always fails.
        const migrationFails = sealSaveEnvelope(saveEnvelope(Migrating.name, 1, { value: 'irrelevant' }))
        yield* storage.put(migratingPreviousKey, good)
        yield* storage.put(migratingKey, migrationFails)

        const restored = yield* loadDurably(Migrating, migratingKey).pipe(Effect.provideService(StoragePort, storage))
        expect(restored).toStrictEqual(Option.some({ value: 'good' }))
      }),
    )

    it.effect('MigrationError + no previous checkpoint: fails with the latest error', () =>
      Effect.gen(function* () {
        const storage = yield* makeInMemoryStorage
        const migrationFails = sealSaveEnvelope(saveEnvelope(Migrating.name, 1, { value: 'irrelevant' }))
        yield* storage.put(migratingKey, migrationFails)

        const result = yield* Effect.either(
          loadDurably(Migrating, migratingKey).pipe(Effect.provideService(StoragePort, storage)),
        )
        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') {
          expect(result.left._tag).toBe('MigrationError')
          expect(result.left.message).toContain('mc-save/test/migrating')
        }
      }),
    )
  })
})

describe('save integrity', () => {
  it('is deterministic across object insertion order and repeated round trips', () => {
    for (let index = 0; index < 100; index += 1) {
      const left = sealSaveEnvelope(saveEnvelope(State.name, 1, { a: index, b: `value-${String(index)}` }))
      const right = sealSaveEnvelope(saveEnvelope(State.name, 1, { b: `value-${String(index)}`, a: index }))
      expect(left.integrity).toStrictEqual(right.integrity)
      expect(sealSaveEnvelope(left).integrity).toStrictEqual(left.integrity)
    }
  })

  it.effect('uses canonical UTF-8 bytes for multi-byte payloads', () =>
    Effect.gen(function* () {
      const sealed = sealSaveEnvelope(saveEnvelope(State.name, 1, { score: 1, label: 'é漢🦊' }))
      expect(sealed.integrity).toStrictEqual({ algorithm: 'fnv1a32', byteLength: 87, checksum: '08574854' })
      expect(yield* validateSaveEnvelope(sealed)).toStrictEqual(sealed)
    }),
  )

  it.effect('rejects non-finite values and saves above the configured byte limit', () =>
    Effect.gen(function* () {
      const nonFinite = sealSaveEnvelope(saveEnvelope(State.name, 1, { score: Number.NaN }))
      expect((yield* Effect.either(validateSaveEnvelope(nonFinite)))._tag).toBe('Left')

      const oversized = sealSaveEnvelope(saveEnvelope(State.name, 1, { text: 'too large' }))
      expect((yield* Effect.either(validateSaveEnvelope(oversized, 1)))._tag).toBe('Left')
    }),
  )

  it.effect('seals its own extensions argument in, and folds a literal undefined leaf into the checksum text', () =>
    Effect.gen(function* () {
      // `sealSaveEnvelope`'s own `extensions` parameter, as opposed to
      // `saveDurably`'s inherited-extensions plumbing exercised elsewhere: a
      // direct caller can attach extensions at seal time too. A value of
      // `undefined` on one of those extension keys is what drives canonicalize
      // through `JSON.stringify(value) ?? 'undefined'` — `JSON.stringify`
      // returns the actual `undefined` value (not the string) for it.
      const withExtensions = sealSaveEnvelope(saveEnvelope(State.name, 1, { score: 1, label: 'x' }), {
        note: undefined,
      })

      expect(withExtensions.extensions).toStrictEqual({ note: undefined })
      expect(yield* validateSaveEnvelope(withExtensions)).toStrictEqual(withExtensions)
    }),
  )
})
