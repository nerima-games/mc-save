/**
 * EVERY VERSION THIS FORMAT HAS EVER HAD, as a frozen historical record.
 *
 * docs/testing.md §4-2 makes "バージョンごとのゴールデン fixture が commit されている"
 * a completion condition, and attaches a rule to it that this file exists to obey:
 *
 *   > fixture を**書き出す仕組み**も同時にある（手書き JSON は禁止。
 *   > 「現行コードが出力するもの」ではなく「人が出力すると思ったもの」を固定してしまう）
 *
 * A hand-written v1 JSON file pins what somebody BELIEVED a v1 build emitted. The
 * only way to pin what one ACTUALLY emitted is to keep the v1 definition alive and
 * run `encodeSave` through it — which is what `scripts/write-save-fixtures.ts`
 * does, using the definitions below.
 *
 * ---------------------------------------------------------------------------
 * THESE DEFINITIONS ARE FROZEN. Changing one is almost always the wrong fix
 * ---------------------------------------------------------------------------
 *
 * `PLAYER_FORMAT_V1` and `PLAYER_FORMAT_V2` describe builds that no longer exist
 * and whose saves are still on disk somewhere. They are history, not code under
 * development, and history does not get edited when the present becomes
 * inconvenient.
 *
 * The failure this guards against is specific and quiet. Suppose someone breaks
 * the v1 to v2 migration. Two things could go red: the committed v1 fixture stops
 * decoding, or — if the historical definition were editable — somebody "fixes" the
 * v1 schema so the broken migration accepts it. The second makes the suite green
 * while every real v1 save on disk stays unreadable, and it is the more tempting
 * of the two because it is a one-line change in a file marked "test".
 *
 * So: if a test in `test/legacy-save-compat.test.ts` goes red, the bug is in the
 * MIGRATION CHAIN or the CURRENT SCHEMA. Reach for this file only when correcting
 * a genuine mis-transcription of what an old build wrote, and say so in the commit.
 *
 * ---------------------------------------------------------------------------
 * Why a synthetic "player" format and not a real consumer's
 * ---------------------------------------------------------------------------
 *
 * There is no real consumer yet. docs/testing.md §4-4 makes "mc-worldgen が実際に
 * `defineFormat` でチャンクフォーマットを定義し、消費している" a separate completion
 * condition, and it is not met. Waiting for it would leave the compat mechanism
 * itself untested until the last repository in the chain lands.
 *
 * The scenario is deliberately the same one `test/migration.test.ts` narrates —
 * a RENAME at v1 to v2, an ADDITION at v2 to v3 — so the repository tells one
 * story rather than two. The difference is where the v1 bytes come from: there
 * they are built in memory inside the test, here they are read off disk from a
 * file committed by an earlier run. That difference is the whole point. An
 * in-memory v1 payload proves the chain is self-consistent today; a committed one
 * proves it still reads what was actually written.
 */
import { Effect, Option, Schema } from 'effect'
import type { SaveEnvelope } from '../../domain/envelope'
import type { SaveDecodeError } from '../../domain/errors'
import { defineFormat, encodeSave, type Migration, type SaveFormat } from '../../domain/format'

/** The format name, stamped into every envelope. Shared by all three versions. */
export const PLAYER_FORMAT_NAME = 'mc-save/test/player-history'

// ---------------------------------------------------------------------------
// v1 — the original shipped shape
// ---------------------------------------------------------------------------

/** FROZEN. What the first build wrote: a world name and `hp`. */
export const PlayerV1Schema = Schema.Struct({
  worldName: Schema.String,
  hp: Schema.Number,
})

export type PlayerV1 = Schema.Schema.Type<typeof PlayerV1Schema>

/**
 * FROZEN. The v1 format, with no migrations because there was nothing before it.
 *
 * `validateMigrationChain` requires exactly this: at `FIRST_VERSION` the chain is
 * empty, and declaring a step here would throw.
 */
export const PLAYER_FORMAT_V1: SaveFormat<PlayerV1, PlayerV1> = defineFormat({
  name: PLAYER_FORMAT_NAME,
  version: 1,
  schema: PlayerV1Schema,
})

// ---------------------------------------------------------------------------
// v2 — `hp` renamed to `health`
// ---------------------------------------------------------------------------

/** FROZEN. What the second build wrote. */
export const PlayerV2Schema = Schema.Struct({
  worldName: Schema.String,
  health: Schema.Number,
})

export type PlayerV2 = Schema.Schema.Type<typeof PlayerV2Schema>

/**
 * A payload as a record, or `None` if it is not one.
 *
 * Every migration below needs this, and each one must decide what to do when the
 * payload is not an object — a migration that assumes its input's shape is how a
 * corrupt save becomes a crash rather than a `MigrationError`.
 */
const asRecord = (payload: unknown): Option.Option<Record<string, unknown>> =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? Option.some(payload as Record<string, unknown>)
    : Option.none()

/**
 * FROZEN. v1 to v2: the rename.
 *
 * This is the step the reference implementation could not express at all. Its
 * entire compatibility story was marking new fields `Schema.optional`
 * (`world-metadata-model.ts:114-117`), which can add a field and never rename
 * one — so a rename would have made every existing save undecodable and was
 * therefore never attempted.
 */
export const RENAME_HP_TO_HEALTH: Migration = {
  from: 1,
  describe: 'renamed `hp` to `health` so the field matches the HUD vocabulary',
  migrate: (payload) =>
    Option.match(asRecord(payload), {
      onNone: () => Effect.fail('expected an object payload'),
      onSome: ({ hp, ...rest }) => Effect.succeed({ ...rest, health: hp }),
    }),
}

/** FROZEN. The v2 format. */
export const PLAYER_FORMAT_V2: SaveFormat<PlayerV2, PlayerV2> = defineFormat({
  name: PLAYER_FORMAT_NAME,
  version: 2,
  schema: PlayerV2Schema,
  migrations: [RENAME_HP_TO_HEALTH],
})

// ---------------------------------------------------------------------------
// v3 — `dimension` added. THE CURRENT VERSION
// ---------------------------------------------------------------------------

/**
 * The CURRENT schema. Unlike the two above, this one is expected to change.
 *
 * `health` gains a range here that v1 and v2 did not state. That is deliberate
 * and is the sharpest thing the committed fixtures check: a migrated payload has
 * to satisfy the CURRENT schema, including constraints introduced after the save
 * was written. `decodeSave` applies the schema last, so an old value outside the
 * new range fails at decode with the "migration chain is probably wrong" reason
 * rather than silently entering the game.
 */
export const PlayerV3Schema = Schema.Struct({
  worldName: Schema.String,
  health: Schema.Number.pipe(Schema.between(0, 20)),
  dimension: Schema.Literal('overworld', 'nether', 'end'),
})

export type PlayerV3 = Schema.Schema.Type<typeof PlayerV3Schema>

/**
 * FROZEN. v2 to v3: the addition, with a real default.
 *
 * `'overworld'` is not a placeholder. Before this version there were no
 * dimensions, so every save that predates it was in the overworld by
 * construction — the default is a statement about history, which is exactly the
 * kind of thing a numbered migration can say and an optional field cannot.
 */
export const ADD_DIMENSION: Migration = {
  from: 2,
  describe: 'added `dimension`; pre-dimension saves were all overworld by construction',
  migrate: (payload) =>
    Option.match(asRecord(payload), {
      onNone: () => Effect.fail('expected an object payload'),
      onSome: (record) => Effect.succeed({ ...record, dimension: 'overworld' }),
    }),
}

/** The current format. This is what production code would hold. */
export const PLAYER_FORMAT_CURRENT: SaveFormat<PlayerV3, PlayerV3> = defineFormat({
  name: PLAYER_FORMAT_NAME,
  version: 3,
  schema: PlayerV3Schema,
  migrations: [RENAME_HP_TO_HEALTH, ADD_DIMENSION],
})

// ---------------------------------------------------------------------------
// The sample value, one per version
// ---------------------------------------------------------------------------

/**
 * The value each historical build is asked to write.
 *
 * FIXED, not generated. A fixture whose contents vary between runs cannot be
 * committed and compared, and a random one would make a failure unreproducible —
 * the same reason `mc-playground-kit/docs/public-api.md` pins its preview seed.
 *
 * The world name carries a non-ASCII character on purpose. The envelope survives
 * a JSON round trip on the way to storage, and a fixture written entirely in
 * ASCII would not notice an encoding regression in that path.
 */
export const SAMPLE_WORLD_NAME = 'ねりま world'

/** The v1 sample. `hp` is within the range v3 later imposes on `health`. */
export const SAMPLE_V1: PlayerV1 = { worldName: SAMPLE_WORLD_NAME, hp: 17 }

/** The v2 sample: the same player, after the rename. */
export const SAMPLE_V2: PlayerV2 = { worldName: SAMPLE_WORLD_NAME, health: 17 }

/** The v3 sample: the same player again, after the addition. */
export const SAMPLE_V3: PlayerV3 = {
  worldName: SAMPLE_WORLD_NAME,
  health: 17,
  dimension: 'overworld',
}

/**
 * WHAT EVERY VERSION MUST DECODE TO once the chain has run.
 *
 * One expected value for all three fixtures, and that is the claim: a v1 save, a
 * v2 save and a v3 save of the same player are the same player. If the chain
 * drops a field or defaults one differently, exactly one of the three rows in
 * `test/legacy-save-compat.test.ts` goes red and names the version that broke.
 */
export const EXPECTED_AFTER_MIGRATION: PlayerV3 = SAMPLE_V3

/**
 * The fixture roster: every version the format has ever had.
 *
 * `validateMigrationChain` already refuses a format whose chain has a hole, so
 * the versions are guaranteed contiguous from 1. This array is what makes the
 * FIXTURES follow that guarantee: `test/legacy-save-compat.test.ts` asserts its
 * length against `PLAYER_FORMAT_CURRENT.version`, so bumping the format without
 * writing a fixture for the version left behind is a failing test.
 */
export const FORMAT_HISTORY: ReadonlyArray<{
  readonly version: number
  /** Produce this version's envelope THROUGH `encodeSave`, never as a literal. */
  readonly write: () => Effect.Effect<SaveEnvelope, SaveDecodeError>
  readonly fixtureFile: string
}> = [
  { version: 1, write: () => encodeSave(PLAYER_FORMAT_V1, SAMPLE_V1), fixtureFile: 'player-v1.json' },
  { version: 2, write: () => encodeSave(PLAYER_FORMAT_V2, SAMPLE_V2), fixtureFile: 'player-v2.json' },
  { version: 3, write: () => encodeSave(PLAYER_FORMAT_CURRENT, SAMPLE_V3), fixtureFile: 'player-v3.json' },
]

/** Where the committed fixtures live, relative to the repository root. */
export const FIXTURE_DIRECTORY = 'test/fixtures/saves'
