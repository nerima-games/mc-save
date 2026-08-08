import { describe, expect, it } from '@effect/vitest'
import { Effect, ParseResult, Schema } from 'effect'
import { FIRST_VERSION, saveEnvelope } from '../src/domain/envelope'
import { decodeSave, defineFormat, encodeSave, validateMigrationChain } from '../src/domain/format'

/**
 * A format whose encoded form differs from its decoded form, so that a
 * round-trip test can actually fail. A format where `A` and `I` coincide would
 * pass `decode(encode(x)) === x` even if both were the identity.
 */
const PlayerStateSchema = Schema.Struct({
  worldId: Schema.String,
  health: Schema.Number.pipe(Schema.between(0, 20)),
  lastPlayed: Schema.DateFromNumber,
})

const PlayerState = defineFormat({
  name: 'mc-save/test/player-state',
  version: 1,
  schema: PlayerStateSchema,
})

describe('encodeSave / decodeSave', () => {
  it.effect('round-trips a value through its encoded representation', () =>
    Effect.gen(function* () {
      const original = {
        worldId: 'world-1',
        health: 17.5,
        lastPlayed: new Date(1_700_000_000_000),
      }

      const envelope = yield* encodeSave(PlayerState, original)
      const restored = yield* decodeSave(PlayerState, envelope)

      expect(restored).toStrictEqual(original)
    }),
  )

  it.effect('stamps the envelope with the format name and current version', () =>
    Effect.gen(function* () {
      const envelope = yield* encodeSave(PlayerState, {
        worldId: 'world-1',
        health: 20,
        lastPlayed: new Date(0),
      })

      expect(envelope.format).toBe('mc-save/test/player-state')
      expect(envelope.version).toBe(1)
      // The encoded payload is the *wire* shape: a number, not a Date. This is
      // what the reference implementation did not have — it stored real `Date`
      // objects via structured clone (`Schema.DateFromSelf`,
      // world-metadata-model.ts:89), which ties the save file to a JS runtime.
      expect(envelope.payload).toStrictEqual({
        worldId: 'world-1',
        health: 20,
        lastPlayed: 0,
      })
    }),
  )

  it.effect('refuses an envelope belonging to a different format, even when the payload would fit', () =>
    Effect.gen(function* () {
      // The payload here is a perfectly valid PlayerState. Only the name differs,
      // and that alone must be disqualifying — otherwise a key collision between
      // two formats decodes as success.
      const foreign = saveEnvelope('mc-save/test/something-else', 1, { worldId: 'w', health: 1, lastPlayed: 0 })
      const result = yield* Effect.flip(decodeSave(PlayerState, foreign))

      expect(result._tag).toBe('SaveDecodeError')
      expect(result.message).toContain('mc-save/test/something-else')
    }),
  )

  /**
   * REGRESSION: a save from a newer build is not corruption.
   *
   * The reference implementation had no way to tell the two apart. Its bulk
   * listing partitioned worlds into `{ valid, corrupt }`
   * (`storage-serialization.ts:43-49`) purely on whether `Schema` accepted
   * them, and the menu rendered anything in `corrupt` as
   * `` `${worldId} (corrupt)` `` with a delete button as the only action
   * (`main-menu-handlers.ts:137-142`). A player who launched an older build
   * was therefore invited to delete a perfectly good world.
   */
  it.effect('reports a save written by a newer build as such, not as corruption', () =>
    Effect.gen(function* () {
      const fromFuture = saveEnvelope('mc-save/test/player-state', 99, { anything: true })
      const result = yield* Effect.flip(decodeSave(PlayerState, fromFuture))

      expect(result._tag).toBe('SaveDecodeError')
      expect(result.message).toContain('newer build')
      expect(result.message).toContain('must not be offered for deletion')
      if (result._tag === 'SaveDecodeError') {
        expect(result.version).toBe(99)
      }
    }),
  )

  it.effect('reports the recorded version when the payload does not satisfy the schema', () =>
    Effect.gen(function* () {
      const broken = saveEnvelope('mc-save/test/player-state', 1, { worldId: 'w', health: 999, lastPlayed: 0 })
      const result = yield* Effect.flip(decodeSave(PlayerState, broken))

      expect(result._tag).toBe('SaveDecodeError')
      if (result._tag === 'SaveDecodeError') {
        expect(result.version).toBe(1)
        expect(result.reason).toContain('current schema')
      }
    }),
  )

  /**
   * `encodeSave`'s own failure path, distinct from `decodeSave`'s: the value in
   * hand satisfies TypeScript but not the schema's ENCODE direction. A struct
   * whose field encoder can itself fail — as opposed to a struct that simply
   * rejects a wrong-shaped `unknown` on decode — is the only way to reach it.
   */
  const NonNegativeOnEncode = Schema.transformOrFail(Schema.Number, Schema.Number, {
    strict: true,
    decode: (n) => ParseResult.succeed(n),
    encode: (n, _options, ast) =>
      n < 0
        ? ParseResult.fail(new ParseResult.Type(ast, n, 'score must not be negative'))
        : ParseResult.succeed(n),
  })

  const ScoreOnly = defineFormat({
    name: 'mc-save/test/score-only',
    version: 1,
    schema: Schema.Struct({ score: NonNegativeOnEncode }),
  })

  it.effect('fails encoding, not decoding, when the value cannot satisfy the schema on its way out', () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(encodeSave(ScoreOnly, { score: -1 }))

      expect(result._tag).toBe('SaveDecodeError')
      expect(result.format).toBe('mc-save/test/score-only')
      expect(result.version).toBe(1)
      expect(result.reason).toBe('the value does not satisfy the format schema, so it cannot be encoded')
    }),
  )
})

describe('validateMigrationChain', () => {
  const noop = { from: 1, describe: 'noop', migrate: (payload: unknown) => Effect.succeed(payload) }

  it.effect('accepts a complete chain', () =>
    Effect.sync(() => {
      expect(
        validateMigrationChain({
          name: 'f',
          version: 3,
          migrations: [noop, { ...noop, from: 2 }],
        }),
      ).toStrictEqual([])
    }),
  )

  it.effect('accepts version 1 with no migrations at all', () =>
    Effect.sync(() => {
      expect(validateMigrationChain({ name: 'f', version: 1, migrations: [] })).toStrictEqual([])
    }),
  )

  it.effect('rejects a hole, naming the version whose saves would become unreadable', () =>
    Effect.sync(() => {
      const problems = validateMigrationChain({
        name: 'f',
        version: 4,
        migrations: [noop, { ...noop, from: 3 }],
      })

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('no migration from version 2 to 3')
    }),
  )

  it.effect('rejects two migrations starting at the same version', () =>
    Effect.sync(() => {
      const problems = validateMigrationChain({
        name: 'f',
        version: 2,
        migrations: [noop, { ...noop, describe: 'other' }],
      })

      expect(problems.some((problem) => problem.includes('must be linear'))).toBe(true)
    }),
  )

  it.effect('rejects a step that would overshoot the declared version', () =>
    Effect.sync(() => {
      const problems = validateMigrationChain({
        name: 'f',
        version: 2,
        migrations: [noop, { ...noop, from: 2 }],
      })

      expect(problems.some((problem) => problem.includes('above the current version'))).toBe(true)
    }),
  )

  it.effect('rejects a non-integer or below-FIRST_VERSION top-level version, and stops there', () =>
    Effect.sync(() => {
      const problems = validateMigrationChain({ name: 'f', version: 0, migrations: [] })

      expect(problems).toStrictEqual([
        `version must be an integer >= ${String(FIRST_VERSION)}, received 0`,
      ])
    }),
  )

  it.effect('rejects a non-integer or below-FIRST_VERSION migration.from', () =>
    Effect.sync(() => {
      const problems = validateMigrationChain({
        name: 'f',
        version: 2,
        migrations: [{ ...noop, from: 0 }],
      })

      expect(
        problems.some((problem) => problem.includes('migration.from must be an integer >=')),
      ).toBe(true)
    }),
  )

  it.effect('rejects any migration declared on a format that starts at FIRST_VERSION', () =>
    Effect.sync(() => {
      // A format at FIRST_VERSION has never had an earlier shape, so there is
      // nothing for a migration to start from — declaring one is always a
      // mistake, never a legitimate chain of one.
      const problems = validateMigrationChain({
        name: 'f',
        version: FIRST_VERSION,
        migrations: [noop],
      })

      expect(
        problems.some((problem) =>
          problem.includes(`version is ${String(FIRST_VERSION)} but 1 migration(s) are declared`),
        ),
      ).toBe(true)
    }),
  )
})

describe('defineFormat', () => {
  it.effect('throws at definition time when the chain has a hole', () =>
    Effect.sync(() => {
      expect(() =>
        defineFormat({
          name: 'mc-save/test/broken',
          version: 3,
          schema: Schema.String,
          migrations: [],
        }),
      ).toThrow(/no migration from version 1 to 2/u)
    }),
  )

  it.effect('sorts migrations into chain order regardless of declaration order', () =>
    Effect.sync(() => {
      const format = defineFormat({
        name: 'mc-save/test/sorted',
        version: 4,
        schema: Schema.Unknown,
        migrations: [
          { from: 3, describe: 'c', migrate: Effect.succeed },
          { from: 1, describe: 'a', migrate: Effect.succeed },
          { from: 2, describe: 'b', migrate: Effect.succeed },
        ],
      })

      expect(format.migrations.map((migration) => migration.from)).toStrictEqual([1, 2, 3])
    }),
  )
})
