/**
 * 旧セーブ fixture との互換テスト — plan.md §3.5's third verification requirement.
 *
 * docs/testing.md §3 listed this as the one unmet row:
 *
 *   > | 旧セーブ fixture との互換テスト | ⬜ **fixture が参照実装に存在しない**。新規作成が必要 |
 *
 * The reason was true and is now discharged. The reference implementation has no
 * old-save fixtures to port because it had no versioning to make one meaningful
 * (see `domain/envelope.ts`: two version numbers, neither read by any branch). So
 * the fixtures are NEW, written by this repository about its own format, by
 * `pnpm fixtures:write`.
 *
 * ---------------------------------------------------------------------------
 * How this differs from `test/migration.test.ts`, and why both exist
 * ---------------------------------------------------------------------------
 *
 * `migration.test.ts` builds a v1 payload in memory and migrates it. That proves
 * the chain is SELF-CONSISTENT: what this build thinks v1 looked like, this build
 * can read.
 *
 * It cannot prove the chain still reads what an older build actually WROTE,
 * because the v1 payload it migrates was produced by the same source tree in the
 * same process. Every test here starts from bytes read off disk that were
 * committed by an earlier act, which is the only version of the claim that has
 * any force.
 *
 * The distinction is not academic. The failure it catches is: someone edits the
 * v1 to v2 migration and, to make it pass, also edits their idea of what v1
 * looked like. In `migration.test.ts` that is one coherent change and the suite
 * stays green. Here the committed file does not move when someone changes their
 * mind, so the same edit goes red.
 */
import { describe, expect, it } from '@effect/vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Effect, Either, Schema } from 'effect'
import { SaveEnvelopeSchema, type SaveEnvelope } from '../domain/envelope'
import { decodeSave } from '../domain/format'
import {
  EXPECTED_AFTER_MIGRATION,
  FIXTURE_DIRECTORY,
  FORMAT_HISTORY,
  PLAYER_FORMAT_CURRENT,
  PLAYER_FORMAT_NAME,
} from './support/player-format-history'

const repositoryRoot = path.resolve(import.meta.dirname, '..')

/**
 * Read a committed fixture and validate it as an envelope.
 *
 * `SaveEnvelopeSchema` and not a cast, because a fixture is untrusted input in
 * exactly the way a real save is: it came off a disk, it was written by another
 * build, and nothing in the type system connects the file to this process. Using
 * the same boundary schema production uses means a malformed fixture fails as a
 * schema error naming the field, not as `undefined is not an object` three frames
 * into a migration.
 */
const readFixture = async (fixtureFile: string): Promise<SaveEnvelope> => {
  const contents = await readFile(path.join(repositoryRoot, FIXTURE_DIRECTORY, fixtureFile), 'utf8')
  return Schema.decodeUnknownSync(SaveEnvelopeSchema)(JSON.parse(contents))
}

describe('旧セーブ fixture との互換テスト', () => {
  /**
   * The roster completeness gate.
   *
   * docs/testing.md §4-2: "フォーマットが持ったことのある全バージョンに fixture がある".
   * `validateMigrationChain` already refuses a format whose MIGRATIONS have a
   * hole; nothing until now refused one whose FIXTURES did. Bumping the format to
   * v4 without writing a v4 fixture now fails here rather than silently leaving
   * v3 as the newest thing anybody ever tries to read.
   */
  it.effect('there is a fixture for every version the format has ever had', () =>
    Effect.sync(() => {
      expect(FORMAT_HISTORY.map((entry) => entry.version)).toStrictEqual([1, 2, 3])
      expect(FORMAT_HISTORY).toHaveLength(PLAYER_FORMAT_CURRENT.version)
    }),
  )

  /**
   * THE LOAD-BEARING ASSERTION. Every committed save decodes to the same player.
   *
   * One expected value across three versions is the claim being made: a v1 save,
   * a v2 save and a v3 save of the same player are the same player once the chain
   * has run. A chain step that drops a field, renames the wrong one, or defaults
   * `dimension` differently breaks exactly one row, and the row names the version.
   */
  for (const entry of FORMAT_HISTORY) {
    it.effect(`a committed v${String(entry.version)} save decodes to the current shape`, () =>
      Effect.gen(function* () {
        const envelope = yield* Effect.promise(() => readFixture(entry.fixtureFile))

        expect(envelope.version).toBe(entry.version)
        expect(envelope.format).toBe(PLAYER_FORMAT_NAME)

        const decoded = yield* decodeSave(PLAYER_FORMAT_CURRENT, envelope)
        expect(decoded).toStrictEqual(EXPECTED_AFTER_MIGRATION)
      }),
    )
  }

  /**
   * The committed v1 file really is v1-SHAPED.
   *
   * Without this, every row above would still pass if `pnpm fixtures:write` had
   * been run with all three entries pointing at the current format — three files
   * with different version stamps and identical modern payloads. The chain would
   * never actually execute a step, and the suite would report full compatibility
   * having migrated nothing.
   *
   * So the shape is asserted directly: v1 has `hp` and no `health`, v2 has
   * `health` and no `dimension`. These are the fields the two migration steps
   * exist to move.
   */
  it.effect('the committed fixtures carry the OLD shapes, not re-stamped modern ones', () =>
    Effect.gen(function* () {
      const v1 = yield* Effect.promise(() => readFixture('player-v1.json'))
      const v2 = yield* Effect.promise(() => readFixture('player-v2.json'))

      expect(v1.payload).toStrictEqual({ worldName: 'ねりま world', hp: 17 })
      expect(v2.payload).toStrictEqual({ worldName: 'ねりま world', health: 17 })

      // Spelled as explicit key checks as well as the deep equals above: a future
      // edit that relaxes the deep comparison should still not be able to let a
      // `dimension` appear in a pre-dimension save.
      expect(Object.keys(v1.payload as object)).not.toContain('health')
      expect(Object.keys(v2.payload as object)).not.toContain('dimension')
    }),
  )

  /**
   * The drift gate: what is on disk is what the frozen definitions produce.
   *
   * This is what keeps `pnpm fixtures:write` honest without putting it in
   * `pnpm verify`. If somebody edits a historical schema in
   * `test/support/player-format-history.ts` — the move that would let a broken
   * migration go green (see that file's header) — the regenerated envelope stops
   * matching the committed one and this fails, naming the version.
   *
   * Deliberately compared as VALUES rather than as serialised text: the test
   * should fail for a changed payload, not for a changed indent.
   */
  for (const entry of FORMAT_HISTORY) {
    it.effect(`the committed v${String(entry.version)} fixture is what encodeSave still produces`, () =>
      Effect.gen(function* () {
        const committed = yield* Effect.promise(() => readFixture(entry.fixtureFile))
        const regenerated = yield* entry.write()
        expect(committed).toStrictEqual(regenerated)
      }),
    )
  }

  /**
   * The CURRENT schema is applied AFTER migration, to old data.
   *
   * v3 added `Schema.between(0, 20)` to `health`; v1 and v2 had no range at all.
   * So a real v1 save can hold a value that the current build must refuse, and
   * the refusal has to happen after the chain has run — which is `decodeSave`'s
   * documented ordering and the thing "just mark it optional" cannot express.
   *
   * The tampered payload is built from the committed fixture rather than typed
   * out, so it stays a genuine v1 envelope with one field moved out of range.
   */
  it.effect('a v1 save whose value violates a LATER constraint is rejected after migrating', () =>
    Effect.gen(function* () {
      const v1 = yield* Effect.promise(() => readFixture('player-v1.json'))
      const outOfRange: SaveEnvelope = {
        ...v1,
        payload: { ...(v1.payload as Record<string, unknown>), hp: 9999 },
      }

      const result = yield* Effect.either(decodeSave(PLAYER_FORMAT_CURRENT, outOfRange))

      expect(Either.isLeft(result)).toBe(true)
      // The reason must point at the chain, not at "corrupt save": the data was
      // valid when written, and telling the player their world is corrupt is the
      // reference implementation's mistake that `domain/envelope.ts` records.
      //
      // Asserted on the error's own `reason` field rather than on a stringified
      // Cause — the Cause spelling escapes its quotes, so a substring match
      // against it passes and fails for reasons about JSON rather than about
      // saves.
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe('SaveDecodeError')
        expect(result.left.reason).toContain('migration chain is probably wrong')
      }
    }),
  )

  /**
   * A fixture belonging to another format is refused by name.
   *
   * Cheap, and it closes the hole where `decodeSave` might be reading the version
   * and ignoring the name — which would let a chunk save be migrated by the
   * player format's chain and land as a schema error far from the cause.
   */
  it.effect('a committed fixture is not accepted by a format with a different name', () =>
    Effect.gen(function* () {
      const v1 = yield* Effect.promise(() => readFixture('player-v1.json'))
      const foreign: SaveEnvelope = { ...v1, format: 'mc-save/test/some-other-format' }

      const result = yield* Effect.either(decodeSave(PLAYER_FORMAT_CURRENT, foreign))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe('SaveDecodeError')
        expect(result.left.reason).toContain('mc-save/test/some-other-format')
        expect(result.left.reason).toContain(PLAYER_FORMAT_NAME)
      }
    }),
  )
})
