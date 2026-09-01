import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Schema } from 'effect'
import { SaveEnvelopeSchema, saveEnvelope, type SaveEnvelope } from '../src/domain/envelope.js'
import { sealAndValidateSaveEnvelope, sealSaveEnvelope, validateSaveEnvelope } from '../src/domain/integrity.js'
import { decodeSave, defineFormat, encodeSave } from '../src/domain/format.js'

/**
 * What this file establishes about versioning, read first:
 *
 * `decodeSave` (`src/domain/format-codec.ts`) accepts exactly one version —
 * `format.version` — and unconditionally rejects every other one, including
 * older ones, with "only the current format version is accepted". That
 * rejection is exercised by `format-roundtrip.test.ts`'s "rejects an older
 * version when no compatibility decoder exists". `git log` on
 * `envelope.ts` / `format-codec.ts` / `format-definition.ts` shows no format
 * has ever had two live versions in this package's history, and no
 * migration/upgrade helper exists anywhere in `src/` (`grep -ri migrat
 * src test` finds nothing before this file). mc-save's own "migration"
 * capability is therefore NOT an automatic upgrade path — it is: (a) a
 * version field that survives storage untouched, (b) unconditional,
 * clearly-labelled rejection of any non-current version so a mismatch never
 * silently misdecodes, and (c) `SaveEnvelopeSchema` exported so a consumer
 * can inspect `envelope.version` and the raw `payload` *before* `decodeSave`
 * would refuse it.
 *
 * A real migration — old bytes becoming a value the current schema accepts —
 * has to be assembled by the consumer from those three primitives: decode
 * the raw envelope, decode `payload` against a schema for the OLD version,
 * transform to the current domain shape, then `encodeSave` under the
 * CURRENT format. This file builds exactly that consumer-side path against
 * a hand-authored v1 fixture (not produced by the current encoder — see
 * `oldFixtureEnvelope` below) and proves it reads correctly. It also proves
 * `decodeSave` itself still refuses the v1 envelope directly, so the two
 * tests together document the real contract: no free migration, but a safe
 * one is buildable.
 */

/**
 * The v1 wire shape a real earlier build would have written. `blocks` is one
 * byte per block (`Schema.Uint8Array`, 0-255), matching the org-wide chunk
 * buffer layout before it widened to two bytes per block. `inventory` uses a
 * bare `null` per empty slot directly in the array — the pre-widening
 * format never routed slots through a named-field null/undefined swap.
 */
const ChunkSaveV1Schema = Schema.Struct({
  worldId: Schema.String,
  blocks: Schema.Uint8Array,
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
const InventorySlotSchema = Schema.transform(Schema.NullOr(Schema.String), Schema.UndefinedOr(Schema.String), {
  strict: true,
  decode: (value) => value ?? undefined,
  encode: (value) => value ?? null,
})

/**
 * The current (v2) wire shape. `blocks` widened to two bytes per block, so
 * block ids up to 65535 are representable — plain numbers rather than
 * `Uint8Array`, since a byte array cannot hold a value over 255 no matter
 * how it is interpreted downstream.
 */
const ChunkSaveV2Schema = Schema.Struct({
  worldId: Schema.String,
  blocks: Schema.Array(
    Schema.Number.pipe(
      Schema.greaterThanOrEqualTo(0),
      Schema.lessThanOrEqualTo(65535),
      Schema.filter((value): value is number => Number.isInteger(value), {
        message: () => 'block id must be an integer',
      }),
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
 * A save as an earlier build actually wrote it, hand-authored in its wire
 * shape rather than produced by any encoder: v1, `blocks` as a plain array
 * of byte values (the JSON-safe form `Schema.Uint8Array` itself decodes
 * from — see `Schema.Uint8Array`'s "Encoded side" in its own error
 * messages), `inventory` using bare `null`. Sealed with the same
 * `sealSaveEnvelope` mc-save has always shipped (integrity is format- and
 * version-agnostic — see `integrity.ts`, unchanged across every commit that
 * touched versioning), so this is a validly-checksummed envelope. Nothing
 * here passes through `ChunkSaveV2Schema` or `encodeSave`, and building the
 * wire object by hand (rather than via `Schema.encode(ChunkSaveV1Schema)`)
 * keeps it independent of any schema this file also uses to read it back.
 */
const oldFixtureWirePayload = {
  worldId: 'overworld-alpha',
  blocks: [0, 1, 2, 255, 7, 0],
  inventory: ['diamond_pickaxe', null, null, 'torch'],
}

const oldFixtureEnvelope: SaveEnvelope = sealSaveEnvelope(
  saveEnvelope(CURRENT_CHUNK_FORMAT.name, 1, oldFixtureWirePayload),
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
      const envelope = yield* Schema.decodeUnknown(SaveEnvelopeSchema)(oldFixtureEnvelope)
      expect(envelope.version).not.toBe(CURRENT_CHUNK_FORMAT.version)
      expect(envelope.version).toBe(1)

      // Step 2: decode the payload against a schema for the OLD version.
      const oldValue = yield* Schema.decodeUnknown(ChunkSaveV1Schema)(envelope.payload)

      // Step 3: transform to the current domain shape.
      const migrated = migrateChunkV1toV2(oldValue)

      // Step 4: re-encode under the CURRENT format and seal for storage.
      const draft = yield* encodeSave(CURRENT_CHUNK_FORMAT, migrated)
      const sealed = yield* sealAndValidateSaveEnvelope(draft, undefined, 16 * 1024 * 1024)
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
      expect(() => Schema.decodeUnknownSync(ChunkSaveV1Schema)({ ...oldValue, blocks: new Uint8Array([300]) })).toThrow()
    }),
  )

  effect('the v1 fixture round-trips against the v1 schema on its own terms, proving it is a real v1 payload', () =>
    Effect.gen(function* () {
      // Guards the fixture itself: if this ever fails, `oldFixtureEnvelope`
      // has drifted from being a legitimate v1 payload and the migration
      // test above would be exercising something else.
      const envelope = yield* Schema.decodeUnknown(SaveEnvelopeSchema)(oldFixtureEnvelope)
      const oldValue = yield* Schema.decodeUnknown(ChunkSaveV1Schema)(envelope.payload)
      expect(oldValue).toStrictEqual({
        worldId: 'overworld-alpha',
        blocks: new Uint8Array([0, 1, 2, 255, 7, 0]),
        inventory: ['diamond_pickaxe', null, null, 'torch'],
      })

      const validated = yield* validateSaveEnvelope(oldFixtureEnvelope)
      expect(validated.integrity.checksum).toBe(oldFixtureEnvelope.integrity.checksum)
    }),
  )
})
