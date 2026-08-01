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
