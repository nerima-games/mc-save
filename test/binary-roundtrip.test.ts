/**
 * PORTED E2E: `storage-service IndexedDB roundtrip works in Chromium`.
 *
 * Reference: ts-minecraft/e2e/contracts/browser-api-contracts.e2e.ts:55-67 and
 * its in-page runner, e2e/contracts/storage-service-contract-runner.ts.
 * mc-compose/docs/e2e-triage.md §3.2 row #8 sends it here, and states why: the
 * reference put it under `e2e/contracts/` only because it had no boundary that
 * owned persistence. mc-save is that boundary.
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
 * only the medium the bytes cross, and see `throughStructuredClone` below for
 * exactly how much of that medium is reproduced here and how much is not.
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
import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Schema } from 'effect'
import type { SaveEnvelope } from '../domain/envelope'
import { defineFormat, encodeSave } from '../domain/format'
import { loadFrom, saveTo } from '../domain/persistence'
import { makeInMemoryStorage, SaveKey, StoragePort } from '../domain/storage-port'

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
 * `Schema.Uint8Array` and not `Schema.Uint8ArrayFromSelf`: the encoded payload
 * is the WIRE shape, on the same rule `test/format-roundtrip.test.ts` states
 * for `Date`. A save file that can only be read by a JavaScript runtime is the
 * reference's mistake, not a constraint.
 */
const ChunkSchema = Schema.Struct({
  blocks: Schema.Uint8Array,
  fluid: Schema.optional(Schema.Uint8Array),
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
 * A `StoragePort` that puts every envelope through the structured clone
 * algorithm on the way in and on the way out.
 *
 * WHAT THIS DOES REPRODUCE. IndexedDB stores values by the structured clone
 * algorithm, so "will this envelope survive being written to a store and read
 * back" is, for the value itself, the same question `structuredClone` answers.
 * A payload holding something unclonable — a function, a closure, a class
 * instance whose prototype matters — fails here for the same reason and with
 * the same shape of error it fails in a browser. The plain in-memory adapter
 * cannot catch any of that: it hands back the identical object it was given, so
 * a round-trip test written against it asserts nothing about serialisation and
 * would go green on a format that no medium could store.
 *
 * WHAT THIS DOES NOT REPRODUCE: transactions, `onupgradeneeded` and store
 * creation, quota, key ordering under a real index, and error mapping from
 * `DOMException`.
 *
 * Those belong to the IndexedDB adapter, and they are no longer a browser
 * question: the adapter exists (`domain/indexeddb-storage.ts`) and every one of
 * them is tested against `test/fake-indexeddb.ts`, whose own header draws this
 * same line for what IT does and does not stand in for. What remains a browser
 * question is only real durability across a reload and real quota pressure.
 *
 * This file is still deliberately written against `StoragePort` rather than
 * against a database, because its claim is about the CODEC and the value that
 * crosses the medium, not about the medium. `domain/storage-port.ts` promised
 * the contract block would be "re-run against the IndexedDB adapter when it
 * lands"; it landed, and that promise is kept in
 * `test/storage-port-contract.ts`.
 */
const throughStructuredClone: Layer.Layer<StoragePort> = Layer.effect(
  StoragePort,
  Effect.map(makeInMemoryStorage, (inner) => ({
    ...inner,
    put: (key: SaveKey, envelope: SaveEnvelope) => inner.put(key, structuredClone(envelope)),
    get: (key: SaveKey) =>
      Effect.map(inner.get(key), Option.map((envelope: SaveEnvelope) => structuredClone(envelope))),
  })),
)

describe('a chunk across the storage medium', () => {
  it.effect('the bytes come back byte-for-byte', () =>
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
    }).pipe(Effect.provide(throughStructuredClone)),
  )

  it.effect('a save that reads back as absent is a lost world, so it must not', () =>
    Effect.gen(function* () {
      // The runner's own failure case, verbatim in intent:
      //   Effect.fail(new Error('StorageService.loadChunk returned none after saveChunk'))
      // `none` is how mc-save says "new world" (`domain/persistence.ts`), so a
      // save that reports itself absent does not read as an error anywhere up
      // the stack — it reads as fresh terrain.
      yield* saveTo(ChunkFormat, CHUNK_KEY, { blocks: SAVED_BLOCKS })
      const loaded = yield* loadFrom(ChunkFormat, CHUNK_KEY)

      expect(Option.isNone(loaded)).toBe(false)
    }).pipe(Effect.provide(throughStructuredClone)),
  )

  it.effect('an omitted optional buffer stays omitted; nothing is invented for it', () =>
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
    }).pipe(Effect.provide(throughStructuredClone)),
  )

  it.effect('what crosses the medium is a wire array, not a runtime buffer', () =>
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
  it.effect('a written chunk shows up in the enumeration, not only under its own key', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort

      expect(yield* storage.keys).toStrictEqual([])

      yield* saveTo(ChunkFormat, CHUNK_KEY, { blocks: SAVED_BLOCKS })

      expect(yield* storage.keys).toStrictEqual([CHUNK_KEY])
    }).pipe(Effect.provide(throughStructuredClone)),
  )
})

/**
 * ---------------------------------------------------------------------------
 * Triage row #9 — WHY IT IS NOT PORTED *HERE*
 * ---------------------------------------------------------------------------
 *
 * UPDATE. Reason (a) below has since been answered: the IndexedDB adapter was
 * written (`domain/indexeddb-storage.ts`), and row #9 is now ported, in
 * `test/indexeddb-storage.test.ts`, as the ADAPTER TEST the triage said it
 * should become. Reason (b) was NOT answered and never will be — it is a
 * design decision, not a gap — so the port asserts this adapter's own store
 * layout and deliberately does not assert `chunks` and `metadata`.
 *
 * The test above is still NOT that port, and its label is still correct. It
 * makes the one claim in row #9 that is about PERSISTENCE rather than about the
 * MEDIUM — that a save which was written is enumerable afterwards — and it makes
 * it through `StoragePort` with no database anywhere in sight. That is why it
 * belongs in this file and not in that one.
 *
 * The original reasoning is kept verbatim below, because it is what the port
 * was built to satisfy.
 *
 * `'minecraft-worlds' IndexedDB is created after game starts`
 * (ts-minecraft/e2e/persistence/save-load.e2e.ts:37-46) asserts three things
 * through `e2e/helpers/db-helpers.ts`:
 *
 *   1. a database NAMED `minecraft-worlds` exists      — `indexedDB.databases()`
 *   2. it has object stores named `chunks` and `metadata`
 *                                                      — `IDBDatabase.objectStoreNames`
 *   3. the `metadata` store is non-empty               — `IDBObjectStore.count()`
 *
 * Two independent things block it, and neither is a matter of effort:
 *
 * (a) THERE IS NO ADAPTER TO ASK. `StoragePort` has exactly two
 *     implementations in this repository, `makeInMemoryStorage` and
 *     `failingStorageLayer`. Neither has a database name or an object store,
 *     because neither has a database. `tsconfig.base.json` says the same thing
 *     from the other side: `lib` is `["ES2024"]` with no `"DOM"`, and its
 *     comment records that the IndexedDB adapter is the one thing that would
 *     add it.
 *
 * (b) EVEN WITH THE ADAPTER, ASSERTIONS 1 AND 2 WOULD NOT SURVIVE THE PORT.
 *     They are assertions about a SCHEMA that mc-save deliberately does not
 *     have. The reference's storage service knew `chunks` and `metadata` by
 *     name (`storage-service.ts:96-139`), and removing exactly that knowledge
 *     is mc-save's design — the header of `domain/storage-port.ts` and of
 *     `index.ts` both say so. A port that asserted "there are stores named
 *     chunks and metadata" would be asserting the reference's design against a
 *     repository built to not have it.
 *
 * So row #9 belongs to whoever writes the IndexedDB adapter — as an adapter
 * test, phrased about that adapter's own store layout, not about the
 * reference's. The part of it that is really about persistence rather than
 * about IndexedDB is `keys`, and that is the test directly above.
 *
 * That is exactly what happened. See the UPDATE at the top of this note.
 */
