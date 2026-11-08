import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { effect } from './support/effect-test.js'
import { applyUntrustedArgument } from './support/apply-untrusted-argument.js'
import { Effect, Result, Schema, SchemaGetter, SchemaTransformation } from 'effect'
import { SaveEnvelopeSchema } from '../src/domain/envelope.js'
import {
  DEFAULT_MAX_SAVE_BYTES,
  resolveSaveMaxBytes,
  sealSaveEnvelope,
  validateSaveEnvelope,
  validateSaveExtensions,
} from '../src/domain/integrity.js'
import {
  decodeSave,
  defineFormat as defineFormatResult,
  defineFormatMigration as defineFormatMigrationResult,
  encodeSave,
  type SaveFormatMigration,
} from '../src/domain/format.js'
import { saveEnvelope } from './support/save-envelope.js'

const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<A, I>
  readonly migrations?: ReadonlyArray<SaveFormatMigration>
}) => Result.getOrThrow(defineFormatResult(spec))
const ChunkSaveV1BlocksSchema = Schema.Array(
  Schema.Number.check(
    Schema.makeFilter<number>((value) =>
      Number.isSafeInteger(value) && value >= 0 && value <= 255
        ? undefined
        : 'v1 block byte must be an integer between 0 and 255',
    ),
  ),
).pipe(
  Schema.decodeTo(Schema.Uint8Array, {
    decode: SchemaGetter.transform((bytes: ReadonlyArray<number>) => new Uint8Array(bytes)),
    encode: SchemaGetter.transform((bytes: Uint8Array) => Array.from(bytes)),
  }),
)

const ChunkSaveV1Schema = Schema.Struct({
  worldId: Schema.String,
  blocks: ChunkSaveV1BlocksSchema,
  inventory: Schema.Array(Schema.NullOr(Schema.String)),
})

/**
 * Per-element null/undefined swap, hand-written for exactly this array.
 * `undefinedFieldsAsNull` (`src/domain/optional-fields.ts`) only swaps named
 * top-level fields; it does not reach into an array's elements, so an
 * inventory slot array — the shape a saved world actually has — needs its
 * own transform or every empty slot decodes as `null` while the rest of the
 * domain uses `undefined` for "absent".
 */
const InventorySlotSchema: Schema.Codec<string | undefined, string | null> = Schema.decodeTo<
  Schema.Codec<string | undefined, string | undefined, never, never>,
  Schema.Codec<string | null, string | null, never, never>,
  never,
  never
>(
  Schema.UndefinedOr(Schema.String),
  SchemaTransformation.transformEffect<string | undefined, string | null>({
    decode: (value) => Effect.succeed(value ?? undefined),
    encode: (value) => Effect.succeed(value ?? null),
  }),
)(Schema.NullOr(Schema.String))

/**
 * The v2 wire shape. `blocks` widened to two bytes per block, so
 * block ids up to 65535 are representable — plain numbers rather than
 * `Uint8Array`, since a byte array cannot hold a value over 255 no matter
 * how it is interpreted downstream.
 */
const ChunkSaveV2Schema = Schema.Struct({
  worldId: Schema.String,
  blocks: Schema.Array(
    Schema.Number.check(
      Schema.makeFilter<number>((value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 65535
          ? undefined
          : 'block id must be an integer between 0 and 65535',
      ),
    ),
  ),
  inventory: Schema.Array(InventorySlotSchema),
})

const ChunkSaveV3Schema = Schema.Struct({
  worldId: Schema.String,
  blocks: Schema.Array(
    Schema.Number.check(
      Schema.makeFilter<number>((value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 65535
          ? undefined
          : 'block id must be an integer between 0 and 65535',
      ),
    ),
  ),
  inventory: Schema.Array(InventorySlotSchema),
  dimension: Schema.Literals(['overworld', 'nether', 'end']),
})

type ChunkSaveV1 = typeof ChunkSaveV1Schema.Type
type ChunkSaveV2 = typeof ChunkSaveV2Schema.Type
type ChunkSaveV2Payload = Schema.Codec.Encoded<typeof ChunkSaveV2Schema>
type ChunkSaveV3Payload = Schema.Codec.Encoded<typeof ChunkSaveV3Schema>

const CHUNK_FORMAT_NAME = 'mc-save/test/migration/chunk'

const LEGACY_CHUNK_FORMAT_V1 = defineFormat({
  name: CHUNK_FORMAT_NAME,
  version: 1,
  schema: ChunkSaveV1Schema,
})

const CHUNK_FORMAT_V2 = defineFormat({
  name: CHUNK_FORMAT_NAME,
  version: 2,
  schema: ChunkSaveV2Schema,
})

const migrateChunkV1ToV2 = (old: ChunkSaveV1): ChunkSaveV2Payload => ({
  worldId: old.worldId,
  blocks: Array.from(old.blocks),
  inventory: old.inventory,
})

const migrateChunkV2ToV3 = (old: ChunkSaveV2): ChunkSaveV3Payload => ({
  ...old,
  inventory: old.inventory.map((slot) => slot ?? null),
  dimension: 'overworld',
})

const CHUNK_V1_TO_V2 = Result.getOrThrow(defineFormatMigrationResult({
  fromVersion: 1,
  schema: ChunkSaveV1Schema,
  migrate: migrateChunkV1ToV2,
}))

const CHUNK_V2_TO_V3 = Result.getOrThrow(defineFormatMigrationResult({
  fromVersion: 2,
  schema: ChunkSaveV2Schema,
  migrate: migrateChunkV2ToV3,
}))

const CHUNK_FORMAT_V2_WITH_MIGRATION = defineFormat({
  name: CHUNK_FORMAT_NAME,
  version: 2,
  schema: ChunkSaveV2Schema,
  migrations: [CHUNK_V1_TO_V2],
})

const CURRENT_CHUNK_FORMAT = defineFormat({
  name: CHUNK_FORMAT_NAME,
  version: 3,
  schema: ChunkSaveV3Schema,
  migrations: [CHUNK_V1_TO_V2, CHUNK_V2_TO_V3],
})

const CURRENT_CHUNK_FORMAT_FROM_V2 = defineFormat({
  name: CHUNK_FORMAT_NAME,
  version: 3,
  schema: ChunkSaveV3Schema,
  migrations: [CHUNK_V2_TO_V3],
})

const encodeHistoricalV1 = (value: ChunkSaveV1) =>
  Effect.gen(function* () {
    const draft = yield* encodeSave(LEGACY_CHUNK_FORMAT_V1, value)
    return yield* Effect.fromResult(sealSaveEnvelope(draft))
  })

const encodeHistoricalV2 = (value: ChunkSaveV2) =>
  Effect.gen(function* () {
    const draft = yield* encodeSave(CHUNK_FORMAT_V2, value)
    return yield* Effect.fromResult(sealSaveEnvelope(draft))
  })

describe('migrating a save written by an earlier build', () => {
  effect('migrates v1 through its single v1 to v2 step', () =>
    Effect.gen(function* () {
      const value: ChunkSaveV1 = {
        worldId: 'overworld-alpha',
        blocks: new Uint8Array([0, 1, 2, 255, 7, 0]),
        inventory: ['diamond_pickaxe', null, null, 'torch'],
      }
      const oldEnvelope = yield* encodeHistoricalV1(value)
      const restored = yield* decodeSave(CHUNK_FORMAT_V2_WITH_MIGRATION, oldEnvelope)

      expect(restored).toStrictEqual({
        worldId: 'overworld-alpha',
        blocks: [0, 1, 2, 255, 7, 0],
        inventory: ['diamond_pickaxe', undefined, undefined, 'torch'],
      })
    }),
  )

  effect('migrates v2 through its single v2 to v3 step', () =>
    Effect.gen(function* () {
      const oldValue: ChunkSaveV2 = {
        worldId: 'overworld-beta',
        blocks: [0, 300, 65_535],
        inventory: ['iron_pickaxe', undefined],
      }
      const oldEnvelope = yield* encodeHistoricalV2(oldValue)
      const restored = yield* decodeSave(CURRENT_CHUNK_FORMAT, oldEnvelope)

      expect(restored).toStrictEqual({ ...oldValue, dimension: 'overworld' })
    }),
  )

  effect('migrates a v1 envelope through every step to the current schema', () =>
    Effect.gen(function* () {
      const oldValue: ChunkSaveV1 = {
        worldId: 'overworld-alpha',
        blocks: new Uint8Array([0, 1, 2, 255, 7, 0]),
        inventory: ['diamond_pickaxe', null, null, 'torch'],
      }
      const oldEnvelope = yield* encodeHistoricalV1(oldValue)
      const restored = yield* decodeSave(CURRENT_CHUNK_FORMAT, oldEnvelope)

      expect(restored).toStrictEqual({
        worldId: 'overworld-alpha',
        blocks: [0, 1, 2, 255, 7, 0],
        inventory: ['diamond_pickaxe', undefined, undefined, 'torch'],
        dimension: 'overworld',
      })
    }),
  )

  effect('rejects a malformed v1 payload before running its migration', () =>
    Effect.gen(function* () {
      const malformed = Result.getOrThrow(
        sealSaveEnvelope(saveEnvelope(CHUNK_FORMAT_NAME, 1, {
          worldId: 'overworld-alpha',
          blocks: [0, 256],
          inventory: ['diamond_pickaxe'],
        })),
      )
      const error = yield* Effect.flip(decodeSave(CURRENT_CHUNK_FORMAT, malformed))

      expect(error._tag).toBe('SaveDecodeError')
      expect(error.version).toBe(1)
      expect(error.reason).toContain('migrated from v1 to v2')
    }),
  )

  effect('returns a typed failure when a legacy version has no migration path', () =>
    Effect.gen(function* () {
      const unsupported = Result.getOrThrow(
        sealSaveEnvelope(saveEnvelope(CHUNK_FORMAT_NAME, 1, { any: 'payload' })),
      )
      const error = yield* Effect.flip(decodeSave(CURRENT_CHUNK_FORMAT_FROM_V2, unsupported))

      expect(error._tag).toBe('SaveDecodeError')
      expect(error.version).toBe(1)
      expect(error.reason).toContain('migration from v1 to v2 is not defined')
      expect(error.reason).toContain('must not be treated as corrupt')
    }),
  )

  effect('returns a typed failure when a migration callback throws', () =>
    Effect.gen(function* () {
      const throwingStep = Result.getOrThrow(defineFormatMigrationResult({
        fromVersion: 2,
        schema: ChunkSaveV2Schema,
        migrate: () => {
          throw Object.create(null)
        },
      }))
      const format = defineFormat({
        name: CHUNK_FORMAT_NAME,
        version: 3,
        schema: ChunkSaveV3Schema,
        migrations: [throwingStep],
      })
      const oldEnvelope = yield* encodeHistoricalV2({
        worldId: 'overworld-beta',
        blocks: [0, 300],
        inventory: [undefined],
      })
      const error = yield* Effect.flip(decodeSave(format, oldEnvelope))

      expect(error._tag).toBe('SaveDecodeError')
      expect(error.version).toBe(2)
      expect(error.reason).toContain('migrated from v2 to v3')
      expect(error.cause).toBeDefined()
    }),
  )

  effect('catches a thrown migration supplied through a direct format definition', () =>
    Effect.gen(function* () {
      const legacy = Result.getOrThrow(
        sealSaveEnvelope(saveEnvelope(CHUNK_FORMAT_NAME, 1, 'legacy')),
      )
      const format = Result.getOrThrow(
        applyUntrustedArgument(defineFormatResult, undefined, [{
          name: CHUNK_FORMAT_NAME,
          version: 2,
          schema: Schema.String,
          migrations: [{
            fromVersion: 1,
            migrate: () => {
              throw new Error('direct migration failed')
            },
          }],
        }]),
      )

      const error = yield* Effect.flip(decodeSave(format, legacy))

      expect(error._tag).toBe('SaveDecodeError')
      expect(error.reason).toContain('migrated from v1 to v2')
      expect(error.cause).toBeInstanceOf(Error)
    }),
  )

  it('migrates arbitrary historical values through the chain with independently derived expectations', () => {
    fc.assert(
      fc.property(
        fc.record({
          worldId: fc.string(),
          blocks: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 32 }),
          inventory: fc.array(fc.option(fc.string(), { nil: null }), { maxLength: 8 }),
        }),
        (value) => {
          const oldValue: ChunkSaveV1 = {
            worldId: value.worldId,
            blocks: Uint8Array.from(value.blocks),
            inventory: value.inventory,
          }
          const oldEnvelope = Effect.runSync(encodeHistoricalV1(oldValue))
          const restored = Effect.runSync(decodeSave(CURRENT_CHUNK_FORMAT, oldEnvelope))

          expect(restored).toStrictEqual({
            worldId: value.worldId,
            blocks: [...value.blocks],
            inventory: value.inventory.map((slot) => slot === null ? undefined : slot),
            dimension: 'overworld',
          })
        },
      ),
    )
  })

  effect('confirms the historical encoder produces a v1 envelope the old schema accepts', () =>
    Effect.gen(function* () {
      const oldValue: ChunkSaveV1 = {
        worldId: 'overworld-alpha',
        blocks: new Uint8Array([0, 1, 2, 255, 7, 0]),
        inventory: ['diamond_pickaxe', null, null, 'torch'],
      }
      const envelope = yield* encodeHistoricalV1(oldValue)
      const parsed = yield* Schema.decodeUnknownEffect(SaveEnvelopeSchema)(envelope)
      const decoded = yield* Schema.decodeUnknownEffect(ChunkSaveV1Schema)(parsed.payload)

      expect(parsed.version).toBe(1)
      expect(decoded).toStrictEqual(oldValue)
      const validated = yield* validateSaveEnvelope(envelope)
      expect(validated.integrity.checksum).toBe(envelope.integrity.checksum)
    }),
  )
})

describe('save boundary defaults', () => {
  effect('uses the max-byte default only when the input is omitted', () =>
    Effect.sync(() => {
      const omitted = resolveSaveMaxBytes(undefined, CURRENT_CHUNK_FORMAT.name, CURRENT_CHUNK_FORMAT.version)
      const explicitNull = resolveSaveMaxBytes(null, CURRENT_CHUNK_FORMAT.name, CURRENT_CHUNK_FORMAT.version)

      expect(omitted).toEqual(Result.succeed(DEFAULT_MAX_SAVE_BYTES))
      expect(Result.isFailure(explicitNull)).toBe(true)
      if (Result.isFailure(explicitNull)) {
        expect(explicitNull.failure.reason).toBe('maxBytes must be a non-negative safe integer')
      }
    }),
  )

  effect('rejects explicit null maxBytes at the envelope validation boundary', () =>
    Effect.gen(function* () {
      const oldEnvelope = yield* encodeHistoricalV1({
        worldId: 'overworld-alpha',
        blocks: new Uint8Array([0, 1]),
        inventory: [null],
      })
      const error = yield* Effect.flip(
        applyUntrustedArgument(validateSaveEnvelope, undefined, [oldEnvelope, null]),
      )

      expect(error._tag).toBe('SaveDecodeError')
      expect(error.reason).toBe('maxBytes must be a non-negative safe integer')
    }),
  )

  effect('treats omitted extensions as absent and explicit null as malformed', () =>
    Effect.sync(() => {
      const omitted = validateSaveExtensions(
        CURRENT_CHUNK_FORMAT.name,
        CURRENT_CHUNK_FORMAT.version,
        undefined,
      )
      const explicitNull = validateSaveExtensions(
        CURRENT_CHUNK_FORMAT.name,
        CURRENT_CHUNK_FORMAT.version,
        null,
      )

      expect(omitted).toEqual(Result.succeed(undefined))
      expect(Result.isFailure(explicitNull)).toBe(true)
      if (Result.isFailure(explicitNull)) {
        expect(explicitNull.failure.reason).toBe('save envelope extensions must be a plain string-keyed object')
      }
    }),
  )
})
