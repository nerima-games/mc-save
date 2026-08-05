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
import { defineFormat } from '../src/domain/format'
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

  it.effect('rejects non-finite values and saves above the configured byte limit', () =>
    Effect.gen(function* () {
      const nonFinite = sealSaveEnvelope(saveEnvelope(State.name, 1, { score: Number.NaN }))
      expect((yield* Effect.either(validateSaveEnvelope(nonFinite)))._tag).toBe('Left')

      const oversized = sealSaveEnvelope(saveEnvelope(State.name, 1, { text: 'too large' }))
      expect((yield* Effect.either(validateSaveEnvelope(oversized, 1)))._tag).toBe('Left')
    }),
  )
})
