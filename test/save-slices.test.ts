import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { Effect, Schema } from 'effect'
import {
  SaveSliceIdSchema,
  SaveVersionSchema,
} from '@nerima-games/mc-kernel/domain/module-contracts'
import {
  defineSaveMigration,
  type SaveSliceRegistration,
} from '@nerima-games/mc-kernel/domain/save-slices'
import { effect } from './support/effect-test.js'
import {
  decodeSaveBundle,
  encodeSaveBundle,
  resolveSaveMigrationPath,
  restoreSaveBundle,
  SaveBundleSnapshotError,
  SaveMigrationPathMissing,
  SaveSliceBundleEntryMissing,
  SaveSliceNotRegistered,
} from '../src/domain/save-slices.js'

const sliceId = (value: string) => Schema.decodeUnknownSync(SaveSliceIdSchema)(value)
const version = (value: number) => Schema.decodeUnknownSync(SaveVersionSchema)(value)

const PreviousSchema = Schema.Struct({ count: Schema.NumberFromString })
const CurrentSchema = Schema.Struct({ count: Schema.NumberFromString, label: Schema.String })

const upgrade = defineSaveMigration(
  version(1),
  version(2),
  PreviousSchema,
  CurrentSchema,
  ({ count }) => ({ count: count + 1, label: 'upgraded' }),
)

describe('save slice bundles', () => {
  effect('keeps an identity migration path empty and fails when no forward path exists', () =>
    Effect.gen(function* () {
      const id = sliceId('inventory')
      const sameVersionPath = yield* resolveSaveMigrationPath({
        id,
        migrations: [],
        fromVersion: version(2),
        toVersion: version(2),
      })
      expect(sameVersionPath).toEqual([])

      const missingPath = yield* Effect.flip(resolveSaveMigrationPath({
        id,
        migrations: [],
        fromVersion: version(1),
        toVersion: version(2),
      }))
      expect(missingPath).toBeInstanceOf(SaveMigrationPathMissing)
    }),
  )

  effect('snapshots and encodes each registered slice', () =>
    Effect.gen(function* () {
      const registration: SaveSliceRegistration<typeof CurrentSchema, never, never> = {
        id: sliceId('inventory'),
        version: version(2),
        schema: CurrentSchema,
        snapshot: Effect.succeed({ count: 6, label: 'slot' }),
        restore: () => Effect.void,
        migrations: [],
      }

      const bundle = yield* encodeSaveBundle([registration])

      expect(bundle).toEqual({
        inventory: { version: version(2), data: { count: '6', label: 'slot' } },
      })
    }),
  )

  effect('decodes, migrates, and restores after preparing the slice', () =>
    Effect.gen(function* () {
      const restored: Array<Schema.Schema.Type<typeof CurrentSchema>> = []
      const registration: SaveSliceRegistration<typeof CurrentSchema, never, never> = {
        id: sliceId('inventory'),
        version: version(2),
        schema: CurrentSchema,
        snapshot: Effect.succeed({ count: 0, label: 'empty' }),
        restore: (state) => {
          restored.push(state)
          return Effect.void
        },
        migrations: [upgrade],
      }

      yield* restoreSaveBundle(
        { inventory: { version: version(1), data: { count: '4' } } },
        [registration],
      )

      expect(restored).toEqual([{ count: 5, label: 'upgraded' }])
    }),
  )

  effect('preflights every slice before invoking any restore', () =>
    Effect.gen(function* () {
      const restored: Array<string> = []
      const first: SaveSliceRegistration<typeof CurrentSchema, never, never> = {
        id: sliceId('first'),
        version: version(2),
        schema: CurrentSchema,
        snapshot: Effect.succeed({ count: 0, label: 'first' }),
        restore: () => {
          restored.push('first')
          return Effect.void
        },
        migrations: [],
      }
      const second: SaveSliceRegistration<typeof CurrentSchema, never, never> = {
        id: sliceId('second'),
        version: version(2),
        schema: CurrentSchema,
        snapshot: Effect.succeed({ count: 0, label: 'second' }),
        restore: () => {
          restored.push('second')
          return Effect.void
        },
        migrations: [upgrade],
      }

      const error = yield* Effect.flip(
        restoreSaveBundle(
          {
            first: { version: version(2), data: { count: '1', label: 'ready' } },
            second: { version: version(1), data: { count: 4 } },
          },
          [first, second],
        ),
      )

      expect(error).toBeInstanceOf(Schema.SchemaError)
      expect(restored).toEqual([])
    }),
  )

  effect('rejects unregistered entries and missing registered slices before restore', () =>
    Effect.gen(function* () {
      const restored: Array<string> = []
      const registration: SaveSliceRegistration<typeof CurrentSchema, never, never> = {
        id: sliceId('inventory'),
        version: version(2),
        schema: CurrentSchema,
        snapshot: Effect.succeed({ count: 0, label: 'empty' }),
        restore: () => {
          restored.push('inventory')
          return Effect.void
        },
        migrations: [],
      }

      const unregistered = yield* Effect.flip(
        restoreSaveBundle(
          {
            inventory: { version: version(2), data: { count: '1', label: 'ready' } },
            extra: { version: version(1), data: { count: '1' } },
          },
          [registration],
        ),
      )
      expect(unregistered).toBeInstanceOf(SaveSliceNotRegistered)
      expect(restored).toEqual([])

      const missing = yield* Effect.flip(restoreSaveBundle({}, [registration]))
      expect(missing).toBeInstanceOf(SaveSliceBundleEntryMissing)
      expect(restored).toEqual([])
    }),
  )

  effect('snapshots bundle getters once before schema decoding and restore', () =>
    Effect.gen(function* () {
      let sliceReads = 0
      let countReads = 0
      const data = Object.defineProperty({}, 'count', {
        enumerable: true,
        get: () => {
          countReads += 1
          return '1'
        },
      })
      Object.defineProperty(data, 'label', { enumerable: true, value: 'ready' })
      const slice = { version: version(2), data }
      const bundle = Object.defineProperty({}, 'inventory', {
        enumerable: true,
        get: () => {
          sliceReads += 1
          return slice
        },
      })
      const registration: SaveSliceRegistration<typeof CurrentSchema, never, never> = {
        id: sliceId('inventory'),
        version: version(2),
        schema: CurrentSchema,
        snapshot: Effect.succeed({ count: 0, label: 'empty' }),
        restore: () => Effect.void,
        migrations: [],
      }

      yield* restoreSaveBundle(bundle, [registration])

      expect(sliceReads).toBe(1)
      expect(countReads).toBe(1)
    }),
  )

  effect('maps a failing bundle getter to a typed snapshot error', () =>
    Effect.gen(function* () {
      const bundle = Object.defineProperty({}, 'inventory', {
        enumerable: true,
        get: () => {
          throw new Error('unreadable bundle')
        },
      })
      const error = yield* Effect.flip(decodeSaveBundle(bundle))

      expect(error).toBeInstanceOf(SaveBundleSnapshotError)
      expect(error._tag).toBe('SaveBundleSnapshotError')
    }),
  )

  effect('encodes, decodes, and restores the __proto__ slice id as an own bundle key', () =>
    Effect.gen(function* () {
      const restored: Array<Schema.Schema.Type<typeof CurrentSchema>> = []
      const registration: SaveSliceRegistration<typeof CurrentSchema, never, never> = {
        id: sliceId('__proto__'),
        version: version(2),
        schema: CurrentSchema,
        snapshot: Effect.succeed({ count: 7, label: 'prototype key' }),
        restore: (state) => {
          restored.push(state)
          return Effect.void
        },
        migrations: [],
      }

      const encoded = yield* encodeSaveBundle([registration])
      expect(Object.hasOwn(encoded, '__proto__')).toBe(true)
      expect(JSON.parse(JSON.stringify(encoded))).toStrictEqual(
        Object.fromEntries([['__proto__', { version: version(2), data: { count: '7', label: 'prototype key' } }]]),
      )

      const persisted: unknown = JSON.parse(JSON.stringify(encoded))
      const decoded = yield* decodeSaveBundle(persisted)
      expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
      expect(Object.keys(decoded)).toEqual(['__proto__'])

      yield* restoreSaveBundle(persisted, [registration])
      expect(restored).toEqual([{ count: 7, label: 'prototype key' }])
    }),
  )

  effect('rejects an empty slice id while decoding an encoded bundle', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeSaveBundle({ '': { version: version(1), data: {} } }))

      expect(error).toBeInstanceOf(Schema.SchemaError)
    }),
  )

  it('keeps the kernel save-version boundary at positive integers', () => {
    const decodeVersion = Schema.decodeUnknownSync(SaveVersionSchema)
    expect(decodeVersion(1)).toBe(1)
    expect(() => decodeVersion(0)).toThrow(Schema.SchemaError)

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (value) => {
        expect(decodeVersion(value)).toBe(value)
      }),
    )

    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: -1 }), (value) => {
        expect(() => decodeVersion(value)).toThrow(Schema.SchemaError)
      }),
    )

    fc.assert(
      fc.property(
        fc.tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 999 }))
          .map(([whole, fraction]) => whole + fraction / 1_000),
        (value) => {
          expect(() => decodeVersion(value)).toThrow(Schema.SchemaError)
        },
      ),
    )
  })

  effect('returns a typed schema error when decoding a zero save version', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeSaveBundle({ inventory: { version: 0, data: {} } }))
      expect(error).toBeInstanceOf(Schema.SchemaError)
    }),
  )

  effect('rejects an explicit null version and an omitted data field', () =>
    Effect.gen(function* () {
      const malformedEntries: ReadonlyArray<unknown> = [
        { inventory: { version: null, data: {} } },
        { inventory: { version: version(1) } },
      ]

      for (const input of malformedEntries) {
        const error = yield* Effect.flip(decodeSaveBundle(input))
        expect(error).toBeInstanceOf(Schema.SchemaError)
      }
    }),
  )

  effect('rejects non-record values while decoding an encoded bundle', () =>
    Effect.gen(function* () {
      for (const input of [null, 'not a bundle', []]) {
        const error = yield* Effect.flip(decodeSaveBundle(input))
        expect(error).toBeInstanceOf(Schema.SchemaError)
      }
    }),
  )
})
