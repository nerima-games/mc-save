import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Result, Schema, SchemaGetter, SchemaTransformation } from 'effect'
import { SaveEnvelopeSchema, type SaveEnvelope } from '../src/domain/envelope.js'
import { SaveMaxBytes } from '../src/domain/brand-types.js'
import { sealAndValidateSaveEnvelope, sealSaveEnvelope, validateSaveEnvelope } from '../src/domain/integrity.js'
import { decodeSave, defineFormat as defineFormatResult, encodeSave } from '../src/domain/format.js'
import { saveEnvelope } from './support/save-envelope.js'

/**
 * `decodeSave` accepts only the declared format version. Consumers that need
 * an older payload must decode it with its old schema and explicitly migrate it
 * before encoding under the current format. The legacy v3 tests below exercise
 * the storage envelope boundary: validate format, version, and integrity
 * before a consumer hands the payload to slice restoration.
 */

/**
 * The v1 wire shape a real earlier build would have written. `blocks` is one
 * byte per block (`Schema.Uint8Array`, 0-255), matching the org-wide chunk
 * buffer layout before it widened to two bytes per block. `inventory` uses a
 * bare `null` per empty slot directly in the array — the pre-widening
 * format never routed slots through a named-field null/undefined swap.
 */
const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<A, I>
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
 * The current (v2) wire shape. `blocks` widened to two bytes per block, so
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

type ChunkSaveV1 = typeof ChunkSaveV1Schema.Type
type ChunkSaveV2 = typeof ChunkSaveV2Schema.Type

const CURRENT_CHUNK_FORMAT = defineFormat({
  name: 'mc-save/test/migration/chunk',
  version: 2,
  schema: ChunkSaveV2Schema,
})

/**
 * The consumer-side upgrade a v1 payload needs. Not part of mc-save's public
 * API — mc-save provides no such helper (see the file banner) — this is
 * what a game-layer migration module would have to write by hand.
 */
const migrateChunkV1toV2 = (old: ChunkSaveV1): ChunkSaveV2 => ({
  worldId: old.worldId,
  blocks: Array.from(old.blocks),
  inventory: old.inventory.map((slot) => slot ?? undefined),
})

/**
 * An earlier build's v1 wire payload. `blocks` used the JSON-safe encoded side
 * of `Schema.Uint8Array`: an array of byte values. Empty inventory slots used
 * bare `null`. The v1 schema adapter validates those bytes before constructing
 * the typed array used by the migration.
 */
const oldFixtureWirePayload = {
  worldId: 'overworld-alpha',
  blocks: [0, 1, 2, 255, 7, 0],
  inventory: ['diamond_pickaxe', null, null, 'torch'],
}

const oldFixtureEnvelope: SaveEnvelope = Result.getOrThrow(
  sealSaveEnvelope(saveEnvelope(CURRENT_CHUNK_FORMAT.name, 1, oldFixtureWirePayload)),
)

const LEGACY_V3_FORMAT = defineFormat({
  name: 'mc-save/test/migration/legacy-world',
  version: 3,
  schema: Schema.Unknown,
})

const legacyV3Payload = {
  slices: {
    world: { version: 3, data: { id: 'overworld-alpha' } },
    chunks: { version: 3, data: [{ x: 4, z: -2, blocks: [0, 300] }] },
  },
}

const legacyV3Envelope: SaveEnvelope = Result.getOrThrow(
  sealSaveEnvelope(saveEnvelope(LEGACY_V3_FORMAT.name, LEGACY_V3_FORMAT.version, legacyV3Payload)),
)

describe('migrating a save written by an earlier build', () => {
  effect('decodeSave refuses the v1 envelope directly — there is no automatic migration', () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(decodeSave(CURRENT_CHUNK_FORMAT, oldFixtureEnvelope))

      expect(result._tag).toBe('SaveDecodeError')
      expect(result.version).toBe(1)
      expect(result.reason).toContain('only the current format version is accepted')
    }),
  )

  effect('the consumer-built migration path reads the v1 fixture correctly under the current format', () =>
    Effect.gen(function* () {
      // Step 1: open the raw envelope the way a consumer must, before
      // `decodeSave` would refuse it — this is the exported primitive that
      // makes migration buildable at all.
      const envelope = yield* Schema.decodeUnknownEffect(SaveEnvelopeSchema)(oldFixtureEnvelope)
      expect(envelope.version).not.toBe(CURRENT_CHUNK_FORMAT.version)
      expect(envelope.version).toBe(1)

      // Step 2: decode the payload against a schema for the OLD version.
      const oldValue = yield* Schema.decodeUnknownEffect(ChunkSaveV1Schema)(envelope.payload)

      // Step 3: transform to the current domain shape.
      const migrated = migrateChunkV1toV2(oldValue)

      // Step 4: re-encode under the CURRENT format and seal for storage.
      const draft = yield* encodeSave(CURRENT_CHUNK_FORMAT, migrated)
      const sealed = yield* sealAndValidateSaveEnvelope(draft, undefined, SaveMaxBytes(16 * 1024 * 1024))
      expect(sealed.version).toBe(2)

      // Step 5: the current code reads the migrated envelope back correctly.
      const restored = yield* decodeSave(CURRENT_CHUNK_FORMAT, sealed)

      expect(restored).toStrictEqual({
        worldId: 'overworld-alpha',
        blocks: [0, 1, 2, 255, 7, 0],
        inventory: ['diamond_pickaxe', undefined, undefined, 'torch'],
      })

      // The width genuinely matters: a block id over 255 is exactly what
      // the v1 `Uint8Array` shape could never have stored, and the migrated
      // (v2) value can. This is not incidental to the migration — it is the
      // reason a migration step (rather than a same-shape re-stamp) is
      // needed at all.
      const widePayload: ChunkSaveV2 = { ...migrated, blocks: [...migrated.blocks, 300] }
      const wideDraft = yield* encodeSave(CURRENT_CHUNK_FORMAT, widePayload)
      const wideRestored = yield* decodeSave(CURRENT_CHUNK_FORMAT, wideDraft)
      expect(wideRestored.blocks).toContain(300)
    }),
  )

  effect('the v1 fixture round-trips against the v1 schema on its own terms, proving it is a real v1 payload', () =>
    Effect.gen(function* () {
      // Guards the fixture itself: if this ever fails, `oldFixtureEnvelope`
      // has drifted from being a legitimate v1 payload and the migration
      // test above would be exercising something else.
      const envelope = yield* Schema.decodeUnknownEffect(SaveEnvelopeSchema)(oldFixtureEnvelope)
      const oldValue = yield* Schema.decodeUnknownEffect(ChunkSaveV1Schema)(envelope.payload)
      expect(oldValue).toStrictEqual({
        worldId: 'overworld-alpha',
        blocks: new Uint8Array([0, 1, 2, 255, 7, 0]),
        inventory: ['diamond_pickaxe', null, null, 'torch'],
      })

      const invalidBytes = yield* Effect.result(
        Schema.decodeUnknownEffect(ChunkSaveV1Schema)({
          ...oldFixtureWirePayload,
          blocks: [0, 256],
        }),
      )
      expect(invalidBytes._tag).toBe('Failure')

      const validated = yield* validateSaveEnvelope(oldFixtureEnvelope)
      expect(validated.integrity.checksum).toBe(oldFixtureEnvelope.integrity.checksum)
    }),
  )

  effect('validates a persisted legacy v3 envelope before handing its payload to restore', () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(SaveEnvelopeSchema)(legacyV3Envelope)
      expect(decoded.format).toBe(LEGACY_V3_FORMAT.name)
      expect(decoded.version).toBe(3)

      const validated = yield* validateSaveEnvelope(decoded)
      expect(validated.integrity).toStrictEqual(legacyV3Envelope.integrity)
      expect(yield* decodeSave(LEGACY_V3_FORMAT, validated)).toStrictEqual(legacyV3Payload)
    }),
  )

  effect('rejects invalid integrity and envelope versions other than legacy v3', () =>
    Effect.gen(function* () {
      const corrupted = {
        ...legacyV3Envelope,
        integrity: {
          ...legacyV3Envelope.integrity,
          checksum: legacyV3Envelope.integrity.checksum === '00000000' ? '00000001' : '00000000',
        },
      }
      const integrityError = yield* Effect.flip(validateSaveEnvelope(corrupted))
      expect(integrityError._tag).toBe('SaveDecodeError')
      expect(integrityError.reason).toContain('checksum')

      for (const version of [1, 2, 4]) {
        const unsupported = Result.getOrThrow(
          sealSaveEnvelope(saveEnvelope(LEGACY_V3_FORMAT.name, version, legacyV3Payload)),
        )
        const versionError = yield* Effect.flip(decodeSave(LEGACY_V3_FORMAT, unsupported))
        expect(versionError._tag).toBe('SaveDecodeError')
        expect(versionError.version).toBe(version)
        expect(versionError.reason).toContain(version > 3 ? 'newer build' : 'only the current format version is accepted')
      }

      const wrongFormat = Result.getOrThrow(
        sealSaveEnvelope(saveEnvelope('mc-save/test/migration/other-format', 3, legacyV3Payload)),
      )
      const formatError = yield* Effect.flip(decodeSave(LEGACY_V3_FORMAT, wrongFormat))
      expect(formatError._tag).toBe('SaveDecodeError')
      expect(formatError.reason).toContain('belongs to format')
    }),
  )
})
