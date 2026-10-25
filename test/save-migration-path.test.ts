import { describe, expect } from 'vitest'
import { Effect, Schema } from 'effect'
import {
  SaveSliceIdSchema,
  SaveVersionSchema,
} from '@nerima-games/mc-kernel/domain/module-contracts'
import { defineSaveMigration } from '@nerima-games/mc-kernel/domain/save-slices'
import { effect } from './support/effect-test.js'
import {
  resolveSaveMigrationPath,
  SaveMigrationPathAmbiguous,
  SaveMigrationPathMissing,
} from '../src/domain/save-slices.js'

const sliceId = Schema.decodeUnknownSync(SaveSliceIdSchema)('inventory')
const version = (value: number) => Schema.decodeUnknownSync(SaveVersionSchema)(value)
const PayloadSchema = Schema.Struct({ value: Schema.Number })

const migration = (from: number, to: number) =>
  defineSaveMigration(
    version(from),
    version(to),
    PayloadSchema,
    PayloadSchema,
    (payload) => payload,
  )

describe('resolveSaveMigrationPath', () => {
  effect('finds the sole increasing path regardless of migration order', () =>
    Effect.gen(function* () {
      const path = yield* resolveSaveMigrationPath({
        id: sliceId,
        fromVersion: version(1),
        toVersion: version(4),
        migrations: [migration(2, 4), migration(1, 3), migration(1, 2)],
      })

      expect(path.map(({ fromVersion, toVersion }) => [fromVersion, toVersion])).toEqual([
        [version(1), version(2)],
        [version(2), version(4)],
      ])
    }),
  )

  effect('reports a missing path', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveSaveMigrationPath({
          id: sliceId,
          fromVersion: version(1),
          toVersion: version(4),
          migrations: [migration(1, 2)],
        }),
      )

      expect(error).toBeInstanceOf(SaveMigrationPathMissing)
      expect(error._tag).toBe('SaveMigrationPathMissing')
      expect(error).toMatchObject({
        id: sliceId,
        storedVersion: version(1),
        currentVersion: version(4),
      })
    }),
  )

  effect('reports multiple increasing paths as ambiguous', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveSaveMigrationPath({
          id: sliceId,
          fromVersion: version(1),
          toVersion: version(4),
          migrations: [
            migration(2, 4),
            migration(3, 4),
            migration(1, 3),
            migration(1, 2),
          ],
        }),
      )

      expect(error).toBeInstanceOf(SaveMigrationPathAmbiguous)
      expect(error._tag).toBe('SaveMigrationPathAmbiguous')
      expect(error).toMatchObject({
        id: sliceId,
        storedVersion: version(1),
        currentVersion: version(4),
      })
    }),
  )

  effect('ignores non-increasing and over-target migration edges', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveSaveMigrationPath({
          id: sliceId,
          fromVersion: version(1),
          toVersion: version(3),
          migrations: [migration(1, 1), migration(1, 4), migration(2, 1)],
        }),
      )

      expect(error).toBeInstanceOf(SaveMigrationPathMissing)
    }),
  )

  effect('reports a missing path when the saved version is newer than the target', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveSaveMigrationPath({
          id: sliceId,
          fromVersion: version(4),
          toVersion: version(2),
          migrations: [migration(2, 4)],
        }),
      )

      expect(error).toBeInstanceOf(SaveMigrationPathMissing)
    }),
  )

  effect('memoizes a shared suffix while reporting converging paths as ambiguous', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveSaveMigrationPath({
          id: sliceId,
          fromVersion: version(1),
          toVersion: version(5),
          migrations: [
            migration(1, 2),
            migration(1, 3),
            migration(2, 4),
            migration(3, 4),
            migration(4, 5),
          ],
        }),
      )

      expect(error).toBeInstanceOf(SaveMigrationPathAmbiguous)
    }),
  )
})
