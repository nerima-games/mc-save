/**
 * Browser-facing persistence contract: an encoded binary payload survives a
 * storage round trip without losing its byte representation.
 *
 * ---------------------------------------------------------------------------
 * The claim, restated
 * ---------------------------------------------------------------------------
 *
 * The reference booted Chromium, imported a runner over `/@fs/`, and asserted
 * four things about one save and one load:
 *
 *   savedBlocks  === [1, 2, 3, 4]      the bytes it wrote
 *   loadedBlocks === savedBlocks       they came back identical
 *   loadedFluid  === [9, 8, 7, 6]      the OPTIONAL second buffer came back too
 *   and the load returned `some` — the runner fails with
 *   'StorageService.loadChunk returned none after saveChunk' otherwise.
 *
 * Not one of those four needs IndexedDB to be *asked*. What needs IndexedDB is
 * only the medium the bytes cross, and the canonical in-memory adapter applies
 * the same structured-clone value boundary as IndexedDB.
 *
 * A chunk is also the payload mc-save exists to serve and the only one it had
 * never been tested with: every existing test in this repository saves a plain
 * record. Binary is the case where "the value round-trips" stops being
 * obviously true, because a `Uint8Array` is the shape a codec is most likely to
 * hand to the medium unencoded.
 *
 * ---------------------------------------------------------------------------
 * What breaks in the game if these go red
 * ---------------------------------------------------------------------------
 *
 * The player's chunk. In the reference, a buffer that came back the wrong size
 * was detected by comparing it against a hard-coded length at
 * `chunk-manager-ops-storage.ts:47-50`, and the only recovery available at that
 * point was to regenerate the chunk — the house the player built, replaced by
 * fresh terrain, with a console line as the only notice.
 */
import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Option, Schema } from 'effect'
import { defineFormat, encodeSave } from '../src/domain/format.js'
import { loadFrom, saveTo } from '../src/domain/persistence.js'
import { InMemoryStorageLayer, SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { fixedUint8Array } from '../src/domain/binary.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

/**
 * A chunk, as mc-worldgen would define it.
 *
 * `blocks` is required and `fluid` is optional, which is the reference's own
 * shape (`storage-service-contract-runner.ts` writes both and reads `fluid`
 * back as possibly `undefined`). The optionality is the half worth keeping:
 * `Schema.optional` was the reference's ENTIRE compatibility story, so a format
 * that has an optional field and never proves it survives a round trip has not
 * tested the mechanism the whole save system rested on.
 *
 * `fixedUint8Array` retains the WIRE shape of `Schema.Uint8Array` while making
 * the dimension invariant executable. A save file that can only be read by a
 * JavaScript runtime is the reference's mistake, not a constraint.
 */
const ChunkSchema = Schema.Struct({
  blocks: fixedUint8Array(4),
  fluid: Schema.optional(fixedUint8Array(4)),
})

type Chunk = Schema.Schema.Type<typeof ChunkSchema>

const ChunkFormat = defineFormat({
  name: 'mc-save/test/chunk',
  version: 1,
  schema: ChunkSchema,
})

/**
 * The reference's key, spelled by the caller.
 *
 * `worldId` `contract-storage-service` at coord `{ x: 7, z: -3 }`. In the
 * reference this string was built inside the adapter
 * (`storage-idb-model.ts:27-28`), which is what made persistence and world
 * generation inseparable. Here it is just a key, and which one a chunk gets is
 * mc-worldgen's business — see the header of `domain/storage-port.ts`.
 */
const CHUNK_KEY = SaveKey('contract-storage-service/chunk/7:-3')

const SAVED_BLOCKS = new Uint8Array([1, 2, 3, 4])
const SAVED_FLUID = new Uint8Array([9, 8, 7, 6])

/**
 * This file stays against `StoragePort` because its claim is about the codec
 * and the value crossing the medium, not about IndexedDB transactions. The
 * canonical in-memory adapter applies structured clone on both sides of the
 * port, while the adapter-specific transaction and DOM error behavior is
 * covered by the IndexedDB tests.
 */
const storageLayer = InMemoryStorageLayer

describe('a chunk across the storage medium', () => {
  effect('rejects a chunk buffer with the wrong exact length', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort

      yield* storage.put(CHUNK_KEY, sealedTestEnvelope(ChunkFormat.name, ChunkFormat.version, { blocks: [1, 2, 3] }))

      const loaded = yield* Effect.either(loadFrom(ChunkFormat, CHUNK_KEY))

      expect(loaded).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'SaveDecodeError',
          format: ChunkFormat.name,
          version: ChunkFormat.version,
        },
      })
    }).pipe(Effect.provide(storageLayer)),
  )

  effect('the bytes come back byte-for-byte', () =>
    Effect.gen(function* () {
      const chunk: Chunk = { blocks: SAVED_BLOCKS, fluid: SAVED_FLUID }

      yield* saveTo(ChunkFormat, CHUNK_KEY, chunk)
      const loaded = yield* loadFrom(ChunkFormat, CHUNK_KEY)

      // The reference's first assertion, and the one it existed for.
      expect(Option.isSome(loaded)).toBe(true)
      if (Option.isSome(loaded)) {
        expect([...loaded.value.blocks]).toStrictEqual([1, 2, 3, 4])
        expect(loaded.value.fluid === undefined ? null : [...loaded.value.fluid]).toStrictEqual([
          9, 8, 7, 6,
        ])
        // A `number[]` that decodes to a `number[]` would satisfy the two
        // assertions above and be useless to a mesher.
        expect(loaded.value.blocks).toBeInstanceOf(Uint8Array)
      }
    }).pipe(Effect.provide(storageLayer)),
  )

  effect('a save that reads back as absent is a lost world, so it must not', () =>
    Effect.gen(function* () {
      // The runner's own failure case, verbatim in intent:
      //   Effect.fail(new Error('StorageService.loadChunk returned none after saveChunk'))
      // `none` is how mc-save says "new world" (`domain/persistence.ts`), so a
      // save that reports itself absent does not read as an error anywhere up
      // the stack — it reads as fresh terrain.
      yield* saveTo(ChunkFormat, CHUNK_KEY, { blocks: SAVED_BLOCKS })
      const loaded = yield* loadFrom(ChunkFormat, CHUNK_KEY)

      expect(Option.isNone(loaded)).toBe(false)
    }).pipe(Effect.provide(storageLayer)),
  )

  effect('an omitted optional buffer stays omitted; nothing is invented for it', () =>
    Effect.gen(function* () {
      // The reference only ever wrote `fluid`, so the branch where a chunk has
      // no fluid at all — every chunk above sea level — was never exercised.
      // A round trip that filled it with an empty `Uint8Array` would put water
      // data on land, and one that failed to decode would make those chunks
      // unloadable.
      yield* saveTo(ChunkFormat, CHUNK_KEY, { blocks: SAVED_BLOCKS })
      const loaded = yield* loadFrom(ChunkFormat, CHUNK_KEY)

      expect(Option.isSome(loaded)).toBe(true)
      if (Option.isSome(loaded)) {
        expect(loaded.value.fluid).toBeUndefined()
        expect([...loaded.value.blocks]).toStrictEqual([1, 2, 3, 4])
      }
    }).pipe(Effect.provide(storageLayer)),
  )

  effect('what crosses the medium is a wire array, not a runtime buffer', () =>
    Effect.gen(function* () {
      // The reference asserted `[1, 2, 3, 4]` on the far side of the browser
      // and never looked at what was stored, because what was stored was a
      // structured-cloned `Uint8Array` — readable only by a JavaScript runtime
      // with the same view of typed arrays. Naming the stored shape here is
      // what makes the save file inspectable, and what makes a change to it a
      // visible diff rather than a silent format break.
      const envelope = yield* encodeSave(ChunkFormat, { blocks: SAVED_BLOCKS, fluid: SAVED_FLUID })

      expect(envelope.format).toBe('mc-save/test/chunk')
      expect(envelope.version).toBe(1)
      expect(envelope.payload).toStrictEqual({ blocks: [1, 2, 3, 4], fluid: [9, 8, 7, 6] })
    }),
  )

  /**
   * NOT a port of triage row #9 (`'minecraft-worlds' IndexedDB is created after
   * game starts`). See the note at the foot of this file. This is the one part
   * of that row's claim mc-save can state at all: a save that was written is
   * enumerable afterwards.
   */
  effect('a written chunk shows up in the enumeration, not only under its own key', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort

      expect(yield* storage.keys).toStrictEqual([])

      yield* saveTo(ChunkFormat, CHUNK_KEY, { blocks: SAVED_BLOCKS })

      expect(yield* storage.keys).toStrictEqual([CHUNK_KEY])
    }).pipe(Effect.provide(storageLayer)),
  )
})

describe('fixedUint8Array', () => {
  effect('rejects invalid lengths before a format can ship', () =>
    Effect.sync(() => {
      expect(() => fixedUint8Array(-1)).toThrow(RangeError)
      expect(() => fixedUint8Array(1.5)).toThrow(RangeError)
      expect(() => fixedUint8Array(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    }),
  )
})

/**
 * Triage row #9 is covered by `test/indexeddb-layout.test.ts`, which verifies
 * the adapter's actual database and object-store layout. This file keeps only
 * the generic `StoragePort` assertion: a written save is enumerable. Store
 * names intentionally stay out of this codec/port test because they are an
 * adapter implementation detail.
 */
