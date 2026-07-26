import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { saveEnvelope } from '../domain/envelope'
import { defineFormat, migrateToCurrent, type Migration } from '../domain/format'
import { loadFrom, saveTo } from '../domain/persistence'
import { InMemoryStorageLayer, SaveKey, StoragePort } from '../domain/storage-port'

/**
 * The scenario these tests pin down is the one the reference implementation
 * could not express.
 *
 * v1  { worldName, hp }                  the original shipped shape
 * v2  { worldName, health }              a RENAME — `Schema.optional` cannot do this
 * v3  { worldName, health, dimension }   an addition, with a real default
 *
 * Step v1→v2 is the important one. Adding a field is the only kind of change
 * the reference could make, because its entire compatibility story was marking
 * new fields optional (`world-metadata-model.ts:114-117`,
 * `inventory-save-data.ts:15`). Renaming one would have made every existing
 * save undecodable, so it was never attempted.
 */

const PlayerV3Schema = Schema.Struct({
  worldName: Schema.String,
  health: Schema.Number.pipe(Schema.between(0, 20)),
  dimension: Schema.Literal('overworld', 'nether', 'end'),
})

type PlayerV3 = Schema.Schema.Type<typeof PlayerV3Schema>

const asRecord = (payload: unknown): Option.Option<Record<string, unknown>> =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? Option.some(payload as Record<string, unknown>)
    : Option.none()

const renameHpToHealth: Migration = {
  from: 1,
  describe: 'renamed `hp` to `health` so the field matches the HUD vocabulary',
  migrate: (payload) =>
    Option.match(asRecord(payload), {
      onNone: () => Effect.fail('expected an object payload'),
      onSome: ({ hp, ...rest }) => Effect.succeed({ ...rest, health: hp }),
    }),
}

const addDimension: Migration = {
  from: 2,
  describe: "added `dimension`; pre-dimension saves were all overworld by construction",
  migrate: (payload) =>
    Option.match(asRecord(payload), {
      onNone: () => Effect.fail('expected an object payload'),
      onSome: (record) => Effect.succeed({ ...record, dimension: 'overworld' }),
    }),
}

const PlayerFormat = defineFormat({
  name: 'mc-save/test/player',
  version: 3,
  schema: PlayerV3Schema,
  migrations: [renameHpToHealth, addDimension],
})

const KEY = SaveKey('world-1/player')

describe('migrateToCurrent', () => {
  it.effect('runs every step from the envelope version up to the current one', () =>
    Effect.gen(function* () {
      const v1 = saveEnvelope('mc-save/test/player', 1, { worldName: 'alpha', hp: 12 })
      const migrated = yield* migrateToCurrent(PlayerFormat, v1)

      expect(migrated).toStrictEqual({ worldName: 'alpha', health: 12, dimension: 'overworld' })
    }),
  )

  it.effect('starts partway through the chain for a save that is only one version behind', () =>
    Effect.gen(function* () {
      const v2 = saveEnvelope('mc-save/test/player', 2, { worldName: 'beta', health: 3 })
      const migrated = yield* migrateToCurrent(PlayerFormat, v2)

      expect(migrated).toStrictEqual({ worldName: 'beta', health: 3, dimension: 'overworld' })
    }),
  )

  it.effect('runs nothing for a current-version save', () =>
    Effect.gen(function* () {
      const payload = { worldName: 'gamma', health: 20, dimension: 'nether' }
      const migrated = yield* migrateToCurrent(PlayerFormat, saveEnvelope('mc-save/test/player', 3, payload))

      expect(migrated).toBe(payload)
    }),
  )

  it.effect('labels a failing step with the format and the exact version pair', () =>
    Effect.gen(function* () {
      const nonsense = saveEnvelope('mc-save/test/player', 1, 'not an object')
      const error = yield* Effect.flip(migrateToCurrent(PlayerFormat, nonsense))

      expect(error._tag).toBe('MigrationError')
      expect(error.fromVersion).toBe(1)
      expect(error.toVersion).toBe(2)
      expect(error.message).toContain('mc-save/test/player')
      // The step's own `describe` survives into the message, so a bug report
      // says which change broke rather than only that "migration 1 → 2 failed".
      expect(error.message).toContain('renamed `hp` to `health`')
    }),
  )
})

describe('loadFrom against a stored v1 save', () => {
  it.effect('migrates a v1 envelope written by an old build all the way to v3', () =>
    Effect.gen(function* () {
      // Simulate an old build: write the v1 envelope through the Port directly,
      // since no current code can produce one.
      const storage = yield* StoragePort
      yield* storage.put(KEY, saveEnvelope('mc-save/test/player', 1, { worldName: 'legacy', hp: 7 }))

      const loaded = yield* loadFrom(PlayerFormat, KEY)

      expect(Option.isSome(loaded)).toBe(true)
      if (Option.isSome(loaded)) {
        expect(loaded.value).toStrictEqual({
          worldName: 'legacy',
          health: 7,
          dimension: 'overworld',
        } satisfies PlayerV3)
      }
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  it.effect('round-trips a current value through storage unchanged', () =>
    Effect.gen(function* () {
      const value: PlayerV3 = { worldName: 'delta', health: 11, dimension: 'end' }

      yield* saveTo(PlayerFormat, KEY, value)
      const loaded = yield* loadFrom(PlayerFormat, KEY)

      expect(loaded).toStrictEqual(Option.some(value))
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  it.effect('treats an absent key as a new world rather than an error', () =>
    Effect.gen(function* () {
      const loaded = yield* loadFrom(PlayerFormat, SaveKey('never-written'))

      expect(loaded).toStrictEqual(Option.none())
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  /**
   * REGRESSION: the toolkit must not trust what came off the medium.
   *
   * `StoragePort` is *typed* as returning a `SaveEnvelope`, but the bytes
   * originate outside this process. The reference implementation read chunks
   * with a raw `db.get` wrapped in `Option.fromNullable` and no Schema at all
   * (`storage-service.ts:111-115`), which is how a wrong-length buffer survived
   * as far as `chunk-manager-ops-storage.ts:47-50` — at which point the only
   * available recovery was to throw the player's chunk away.
   */
  it.effect('rejects a stored value that is not a well-formed envelope', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      // Deliberately bypassing the type: this is what a corrupt record looks like.
      yield* storage.put(KEY, { format: '', version: 0, payload: null })

      const error = yield* Effect.flip(loadFrom(PlayerFormat, KEY))

      expect(error._tag).toBe('SaveDecodeError')
      expect(error.message).toContain('well-formed save envelope')
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )
})
