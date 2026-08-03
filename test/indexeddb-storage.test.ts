/**
 * The IndexedDB adapter, and the port of E2E triage row #9.
 *
 * ---------------------------------------------------------------------------
 * PORTED E2E: `'minecraft-worlds' IndexedDB is created after game starts`
 * ---------------------------------------------------------------------------
 *
 * Reference: ts-minecraft/e2e/persistence/save-load.e2e.ts:37-46 via
 * e2e/helpers/db-helpers.ts. mc-compose/docs/e2e-triage.md §3.3 row #9 marks it
 * DEMOTE → mc-save, and then marks it NOT PORTED for two stated reasons. Both
 * are now answerable, and the answers are not the same:
 *
 *   (a) THERE WAS NO ADAPTER TO ASK. There is now — `domain/indexeddb-storage.ts`
 *       — so the question has somewhere to go.
 *
 *   (b) TWO OF ITS THREE ASSERTIONS DO NOT SURVIVE THE PORT, and that has not
 *       changed. The row asserted:
 *
 *         1. a database NAMED `minecraft-worlds` exists
 *         2. it has object stores named `chunks` and `metadata`
 *         3. the `metadata` store is non-empty
 *
 *       Assertion 2 is about the REFERENCE'S SCHEMA, and removing exactly that
 *       knowledge is mc-save's design (`domain/storage-port.ts` header,
 *       `index.ts` header). Asserting it here would be asserting the
 *       reference's design against a repository built to not have it. Assertion
 *       1 is half portable: the NAME `minecraft-worlds` belongs to the game, not
 *       to the persistence toolkit, for the same reason the key `worldId:x:z`
 *       does. What mc-save can own is that the adapter opens THE NAME IT WAS
 *       GIVEN, verbatim, and creates ITS OWN layout under it.
 *
 * So the row is ported as the triage says it should be — "IndexedDB アダプタを
 * 書く者のアダプタテストとして残す", an adapter test phrased about this
 * adapter's own store layout — and the block below says so at each assertion.
 *
 * `test/binary-roundtrip.test.ts` carries a test explicitly labelled as NOT a
 * port of this row, and that label is still correct: it makes the one claim
 * about ENUMERATION that is really about persistence rather than about the
 * medium, and it makes it through `StoragePort` with no database in sight.
 * This file makes the claims that genuinely need a database.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Option, Schema } from 'effect'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { saveEnvelope } from '../src/domain/envelope'
import { defineFormat } from '../src/domain/format'
import {
  INSERTION_INDEX_NAME,
  indexedDbStorageLayer,
  isQuotaExceeded,
  makeIndexedDbStorage,
  SAVE_STORE_NAME,
  STORE_LAYOUT_VERSION,
} from '../src/domain/indexeddb-storage'
import { loadFrom, saveTo } from '../src/domain/persistence'
import { SaveKey, StoragePort } from '../src/domain/storage-port'
import { makeFakeIndexedDb, QUOTA_EXCEEDED_ERROR, type FakeIndexedDb } from './fake-indexeddb'
import { storagePortContract } from './storage-port-contract'

const DATABASE = 'mc-save/test/worlds'
const A = SaveKey('alpha')
const B = SaveKey('beta')
const envelope = (payload: unknown) => saveEnvelope('mc-save/test/idb', 1, payload)

const layerFor = (factory: FakeIndexedDb, databaseName = DATABASE) =>
  indexedDbStorageLayer({ factory, databaseName })

/** A fresh medium per run, which is what isolation means for a real adapter. */
const freshLayer = () => layerFor(makeFakeIndexedDb())

// ---------------------------------------------------------------------------
// The promise `domain/storage-port.ts` made, kept
// ---------------------------------------------------------------------------

storagePortContract('IndexedDB', freshLayer)

// ---------------------------------------------------------------------------
// Triage row #9, as much of it as mc-save can own
// ---------------------------------------------------------------------------

describe("PORTED E2E (row #9): the adapter's own database and layout", () => {
  it.effect('creates a database under the name it was given, and no other', () =>
    Effect.gen(function* () {
      // Reference assertion 1, minus the constant. `db-helpers.ts` asked
      // `indexedDB.databases()` for a database literally named
      // `minecraft-worlds`; mc-save has no business knowing that string, so
      // what is asserted is that the caller's name is used VERBATIM.
      //
      // `docs/design-notes.md` wanted a regression test that the adapter opens
      // `'minecraft-worlds'` and not `'ts-minecraft'` — "1 行だが、間違えたら
      // 全プレイヤーのワールドが消えたように見える". This is that test with the
      // constant moved to its owner: get the name wrong here and every world
      // looks deleted just the same.
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ world: 1 }))
      }).pipe(Effect.provide(layerFor(factory, 'a-name-mc-save-did-not-choose')))

      expect(factory.databaseNames()).toStrictEqual(['a-name-mc-save-did-not-choose'])
    }),
  )

  it.effect('creates ITS OWN store layout, not the reference’s chunks/metadata', () =>
    Effect.gen(function* () {
      // Reference assertion 2, inverted. The row asserted stores named `chunks`
      // and `metadata`; asserting those here would re-import the schema this
      // repository deliberately dropped (`domain/storage-port.ts` header: the
      // reference's adapter knew a chunk was keyed `worldId:x:z`, which is what
      // made persistence and world generation inseparable).
      //
      // So the claim is the opposite one, and it is the stronger of the two:
      // there is exactly ONE store, it is the adapter's, and the reference's
      // two are absent.
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({}))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(factory.storeNamesOf(DATABASE)).toStrictEqual([SAVE_STORE_NAME])
      expect(factory.storeNamesOf(DATABASE)).not.toContain('chunks')
      expect(factory.storeNamesOf(DATABASE)).not.toContain('metadata')
      expect(factory.indexNamesOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([INSERTION_INDEX_NAME])
    }),
  )

  it.effect('the store is non-empty after a save, and holds one record per key', () =>
    Effect.gen(function* () {
      // Reference assertion 3, which IS portable: `metadata.count()` was really
      // asking "did starting the game write anything at all". Phrased about the
      // adapter's own store, that survives intact.
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
        yield* storage.put(B, envelope({ n: 2 }))
        yield* storage.put(A, envelope({ n: 3 }))
      }).pipe(Effect.provide(layerFor(factory)))

      const records = factory.recordsOf(DATABASE, SAVE_STORE_NAME) ?? []
      expect(records.length).toBe(2)
    }),
  )

  it.effect('the record shape is inspectable: key, insertion sequence, envelope', () =>
    Effect.gen(function* () {
      // `test/binary-roundtrip.test.ts` states the rule this follows: naming the
      // stored shape "is what makes the save file inspectable, and what makes a
      // change to it a visible diff rather than a silent format break". The
      // reference never looked at what was stored, which is how a wrong-sized
      // buffer reached `chunk-manager-ops-storage.ts:47-50`.
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: { format: 'mc-save/test/idb', version: 1, payload: { n: 1 } } },
      ])
    }),
  )

  it.effect('opens at the layout version it declares', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        yield* StoragePort
      }).pipe(Effect.provide(layerFor(factory)))

      const listed = (yield* Effect.promise(() => factory.databases?.() ?? Promise.resolve([]))) ?? []
      expect(listed).toStrictEqual([{ name: DATABASE, version: STORE_LAYOUT_VERSION }])
    }),
  )
})

// ---------------------------------------------------------------------------
// Insertion order: the claim a medium-backed adapter does not get for free
// ---------------------------------------------------------------------------

describe('insertion order survives the medium', () => {
  it.effect('keys answers in insertion order, NOT in ascending key order', () =>
    Effect.gen(function* () {
      // The contract block already asserts two keys. Four written in descending
      // alphabetical order is what tells the two orderings apart beyond doubt:
      // `getAllKeys()` on the store would answer a,b,c,d for any input.
      const storage = yield* StoragePort
      yield* storage.put(SaveKey('delta'), envelope({}))
      yield* storage.put(SaveKey('charlie'), envelope({}))
      yield* storage.put(SaveKey('bravo'), envelope({}))
      yield* storage.put(SaveKey('alpha'), envelope({}))

      expect(yield* storage.keys).toStrictEqual(['delta', 'charlie', 'bravo', 'alpha'])
    }).pipe(Effect.provide(freshLayer())),
  )

  it.effect('a re-written key keeps its original position, it does not move to the end', () =>
    Effect.gen(function* () {
      // `Map.set` gives the in-memory adapter this for nothing. IndexedDB gives
      // it nothing at all: a `put` that allocated a new sequence number would
      // silently reorder the world list every time a world was saved.
      const storage = yield* StoragePort
      yield* storage.put(SaveKey('first'), envelope({}))
      yield* storage.put(SaveKey('second'), envelope({}))
      yield* storage.put(SaveKey('first'), envelope({ again: true }))

      expect(yield* storage.keys).toStrictEqual(['first', 'second'])
    }).pipe(Effect.provide(freshLayer())),
  )

  it.effect('a deleted key does not hand its sequence number to the next writer', () =>
    Effect.gen(function* () {
      // The reason the next sequence number comes from the index's LARGEST
      // value rather than from the record count: after a delete the count is
      // one less than the high-water mark, so counting hands the freed number
      // to the next writer and two records end up sharing a sequence.
      //
      // The enumeration is asserted on the SEQUENCE NUMBERS and not only on the
      // order, deliberately. Two records with equal sequences still come back in
      // a plausible order — a stable sort leaves them in the order the store
      // happened to hold them — so an order-only assertion goes green on exactly
      // the bug it was written to catch, and only starts failing later, on a
      // machine whose iteration order differs. This is that test written so it
      // cannot do that.
      const factory = makeFakeIndexedDb()

      const keys = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(SaveKey('one'), envelope({}))
        yield* storage.put(SaveKey('two'), envelope({}))
        yield* storage.remove(SaveKey('one'))
        yield* storage.put(SaveKey('three'), envelope({}))
        return yield* storage.keys
      }).pipe(Effect.provide(layerFor(factory)))

      expect(keys).toStrictEqual(['two', 'three'])

      const sequences = (factory.recordsOf(DATABASE, SAVE_STORE_NAME) ?? []).map(
        (record) => (record as { readonly seq: number }).seq,
      )
      expect(new Set(sequences).size).toBe(sequences.length)
    }),
  )
})

// ---------------------------------------------------------------------------
// Error mapping. The channel is StorageError and stays StorageError.
// ---------------------------------------------------------------------------

describe('what the medium can do wrong, and what the caller is told', () => {
  it.effect('a quota failure is a StorageError the retry policy can recognise', () =>
    Effect.gen(function* () {
      // `domain/errors.ts` says the retry policy "belongs on top of this type
      // rather than inside it", and records what the reference's policy did:
      // `Schedule.exponential(100ms)`, 3 attempts, aborting on
      // `QuotaExceededError`. A policy can only abort on what it can see, so
      // this is the one distinction spelled into `operation`.
      const factory = makeFakeIndexedDb()
      factory.failNextWrite(QUOTA_EXCEEDED_ERROR)

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.put(A, envelope({})))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(isQuotaExceeded(error)).toBe(true)
      expect(error.key).toBe('alpha')
      expect(error.message).toContain('alpha')
    }),
  )

  it.effect('an ordinary DOMException is NOT reported as quota, so it stays retryable', () =>
    Effect.gen(function* () {
      // The half that matters more. Marking everything as quota would make the
      // policy give up on a transient failure and lose the player's save; the
      // marker has to be false for the common case.
      const factory = makeFakeIndexedDb()
      factory.failNextWrite('UnknownError', 'the medium hiccuped')

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.put(A, envelope({})))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(isQuotaExceeded(error)).toBe(false)
      expect(error.operation).toBe('indexeddb.put')
    }),
  )

  it.effect('a transaction that aborts fails the write AND leaves the store untouched', () =>
    Effect.gen(function* () {
      // A browser may abort a transaction of its own accord, with `error` null.
      // Two things must hold and the second is the one that is easy to miss: the
      // caller must be told, and the store must not have half a write in it.
      //
      // The abort is injected AFTER the write lands (`abortAfterNextWrite`), so
      // there is genuinely a half-done transaction to roll back. Aborting
      // earlier would leave the store unchanged for the trivial reason that
      // nothing had been written yet, and the second assertion would hold
      // against an adapter with no rollback at all.
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ n: 1 }))
        factory.abortAfterNextWrite()
        return yield* Effect.flip(storage.put(B, envelope({ n: 2 })))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.put')
      // Rolled back: `beta` never landed, and `alpha` is exactly as it was.
      expect((factory.recordsOf(DATABASE, SAVE_STORE_NAME) ?? []).length).toBe(1)
    }),
  )

  it.effect('commitBatch rolls back earlier writes when a later mutation fails', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()
      const invalid = envelope({ cannotClone: () => undefined })

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(A, envelope({ original: true }))
        return yield* Effect.flip(
          storage.commitBatch([
            { _tag: 'Put', key: A, envelope: envelope({ overwritten: true }) },
            { _tag: 'Put', key: B, envelope: invalid },
          ]),
        )
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error.operation).toBe('indexeddb.commitBatch')
      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: envelope({ original: true }) },
      ])
    }),
  )

  it.effect('commitBatch reports a browser abort and rolls the whole checkpoint back', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        factory.abortAfterNextWrite()
        return yield* Effect.flip(
          storage.commitBatch([
            { _tag: 'Put', key: A, envelope: envelope({ n: 1 }) },
            { _tag: 'Put', key: B, envelope: envelope({ n: 2 }) },
          ]),
        )
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error.operation).toBe('indexeddb.commitBatch')
      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([])
    }),
  )

  it.effect('a blocked upgrade fails rather than waiting forever', () =>
    Effect.gen(function* () {
      // The DOM does not treat `blocked` as an error: the open stays pending
      // until the other connection closes, possibly never. Waiting is the worse
      // failure — a title screen that never loads and no message anywhere. The
      // operation names it so a bug report can tell it from a real open failure.
      // A holder at a version BELOW ours is what blocks, because our open is
      // then an upgrade and an upgrade cannot run while anyone else is
      // connected.
      const factory = makeFakeIndexedDb()
      factory.holdOpenAt(DATABASE, STORE_LAYOUT_VERSION - 1)

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* StoragePort
        }).pipe(Effect.provide(layerFor(factory))),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          yield* StoragePort
        }).pipe(Effect.provide(layerFor(factory))),
      )
      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.open:blocked')
    }),
  )

  it.effect('a record this adapter did not write is an error, never a silent none', () =>
    Effect.gen(function* () {
      // `none` means "new world" everywhere up the stack
      // (`domain/persistence.ts`), and `test/binary-roundtrip.test.ts` states
      // what that costs: a save that reports itself absent "does not read as an
      // error anywhere up the stack — it reads as fresh terrain". So a present
      // but unrecognisable record must be loud.
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, STORE_LAYOUT_VERSION, SAVE_STORE_NAME, [
        { key: 'alpha', seq: 0, somethingElse: 'not an envelope' },
      ])

      const error = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return yield* Effect.flip(storage.get(A))
      }).pipe(Effect.provide(layerFor(factory)))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.get')
    }),
  )

  it.effect('operating on a closed connection is a StorageError, not a defect', () =>
    Effect.gen(function* () {
      // The state `onversionchange` deliberately creates: another tab is
      // upgrading, this connection closed itself, and the next write throws
      // `InvalidStateError` synchronously out of `transaction()`. A defect here
      // would crash the frame instead of reaching the save UI.
      const factory = makeFakeIndexedDb()

      const storage = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeIndexedDbStorage({ factory, databaseName: DATABASE })
          yield* service.put(A, envelope({}))
          return service
        }),
      )

      // The scope closed, so `close()` has run.
      const error = yield* Effect.flip(storage.put(B, envelope({})))
      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('indexeddb.put')
    }),
  )
})

// ---------------------------------------------------------------------------
// Upgrade, and a database an older build left behind
// ---------------------------------------------------------------------------

describe('onupgradeneeded and a database written by an older version', () => {
  it.effect('creates the store and index on a database that has never been opened', () =>
    Effect.gen(function* () {
      const factory = makeFakeIndexedDb()

      yield* Effect.gen(function* () {
        yield* StoragePort
      }).pipe(Effect.provide(layerFor(factory)))

      expect(factory.storeNamesOf(DATABASE)).toStrictEqual([SAVE_STORE_NAME])
      expect(factory.indexNamesOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([INSERTION_INDEX_NAME])
    }),
  )

  it.effect('an older database keeps every record it had — nothing is rewritten', () =>
    Effect.gen(function* () {
      // THE ANSWER TO "what happens to a database written by an older version".
      //
      // The upgrade touches STRUCTURE only, per `docs/public-api.md` §8:
      // "mc-save ではスキーマ移行は `defineFormat` の連鎖が担い、IndexedDB の
      // `upgrade` はストア構造の変更だけに限定する". So an older database opens,
      // gains whatever structure was missing, and its records are untouched —
      // including records whose ENVELOPE is at an older format version, which is
      // `decodeSave`'s problem and not the medium's.
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, 0, SAVE_STORE_NAME, [
        { key: 'alpha', seq: 0, envelope: { format: 'mc-save/test/idb', version: 1, payload: { n: 1 } } },
        { key: 'beta', seq: 1, envelope: { format: 'mc-save/test/idb', version: 1, payload: { n: 2 } } },
      ])

      const found = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        return { keys: yield* storage.keys, alpha: yield* storage.get(A) }
      }).pipe(Effect.provide(layerFor(factory)))

      expect(found.keys).toStrictEqual([A, B])
      expect(found.alpha).toStrictEqual(Option.some(envelope({ n: 1 })))
    }),
  )

  it.effect('a new key written after an upgrade continues the old sequence', () =>
    Effect.gen(function* () {
      // The consequence of not rewriting: the sequence counter is DERIVED from
      // what is in the store, so it survives an upgrade without being stored
      // anywhere. A counter kept in memory would restart at zero on every
      // launch and interleave new worlds among the old ones.
      const factory = makeFakeIndexedDb()
      factory.seed(DATABASE, 0, SAVE_STORE_NAME, [
        { key: 'zulu', seq: 7, envelope: { format: 'mc-save/test/idb', version: 1, payload: {} } },
      ])

      const keys = yield* Effect.gen(function* () {
        const storage = yield* StoragePort
        yield* storage.put(SaveKey('alpha'), envelope({}))
        return yield* storage.keys
      }).pipe(Effect.provide(layerFor(factory)))

      // `alpha` sorts before `zulu`; insertion order puts it after.
      expect(keys).toStrictEqual(['zulu', 'alpha'])
    }),
  )

  it.effect('the layout version and the save-format version are different numbers', () =>
    Effect.gen(function* () {
      // `domain/envelope.ts` was written to end the confusion of two version
      // numbers that both looked like "the save version" and neither of which
      // did anything (`storage-idb-model.ts:7` and `chunk.ts:9`, plus the
      // separate `saveVersion` read only by a log line). Here they are told
      // apart by construction: a format at version 3 lands in a store whose
      // layout version is 1, the envelope records 3, the database records 1,
      // and neither number moves the other.
      const factory = makeFakeIndexedDb()
      const identity = (payload: unknown) => Effect.succeed(payload)
      const AtVersionThree = defineFormat({
        name: 'mc-save/test/idb-versioned',
        version: 3,
        schema: Schema.Struct({ n: Schema.Number }),
        // `defineFormat` refuses a format whose chain has a gap, so a v3 format
        // must carry both steps. That refusal is itself the point being made
        // here: the SAVE format has a migration ladder, and the STORE layout
        // has none and needs none.
        migrations: [
          { from: 1, describe: 'no shape change', migrate: identity },
          { from: 2, describe: 'no shape change', migrate: identity },
        ],
      })

      yield* saveTo(AtVersionThree, A, { n: 1 }).pipe(Effect.provide(layerFor(factory)))

      const listed = (yield* Effect.promise(() => factory.databases?.() ?? Promise.resolve([]))) ?? []
      expect(listed).toStrictEqual([{ name: DATABASE, version: STORE_LAYOUT_VERSION }])
      expect(factory.recordsOf(DATABASE, SAVE_STORE_NAME)).toStrictEqual([
        { key: 'alpha', seq: 0, envelope: { format: 'mc-save/test/idb-versioned', version: 3, payload: { n: 1 } } },
      ])
    }),
  )
})

// ---------------------------------------------------------------------------
// End to end through the toolkit, not just through the Port
// ---------------------------------------------------------------------------

describe('a save crosses the real seam', () => {
  it.effect('saveTo then loadFrom round-trips through a database', () =>
    Effect.gen(function* () {
      // Every other test here drives `StoragePort` directly. This one goes
      // through the codec, which is the path the game actually takes, and
      // therefore also proves the envelope survives structured clone in the
      // fake — the property `test/binary-roundtrip.test.ts` isolates.
      const Chunk = defineFormat({
        name: 'mc-save/test/idb-chunk',
        version: 1,
        schema: Schema.Struct({ blocks: Schema.Uint8Array }),
      })

      yield* saveTo(Chunk, A, { blocks: new Uint8Array([1, 2, 3, 4]) })
      const loaded = yield* loadFrom(Chunk, A)

      expect(Option.isSome(loaded)).toBe(true)
      if (Option.isSome(loaded)) {
        expect([...loaded.value.blocks]).toStrictEqual([1, 2, 3, 4])
        expect(loaded.value.blocks).toBeInstanceOf(Uint8Array)
      }
    }).pipe(Effect.provide(freshLayer())),
  )
})

// ---------------------------------------------------------------------------
// The property this whole design rests on
// ---------------------------------------------------------------------------

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('REGRESSION: the IndexedDB surface is a real subset of the real DOM', () => {
  it.effect(
    'a real IDBFactory, IDBDatabase and IDBRequest satisfy the adapter without a cast',
    () =>
      Effect.sync(() => {
        // The claim `domain/indexeddb-surface.ts` makes, checked rather than
        // asserted. It is NOT obvious and NOT stable under a careless edit:
        // under `strictFunctionTypes` a function-typed PROPERTY is contravariant
        // in its parameter, so the spelling everybody reaches for first —
        // `onsuccess: (() => void) | null` — makes a real `IDBRequest`
        // unassignable with "Target signature provides too few arguments".
        // Nothing in `pnpm typecheck` would notice, because that project has no
        // DOM to be assignable FROM; the first person to notice would be a
        // browser consumer, and the fix they would reach for is
        // `as unknown as`, which is where the type safety would actually be lost.
        const fixture = path.join(repositoryRoot, 'test', 'fixtures', 'indexeddb-surface.ts')
        const program = ts.createProgram({
          rootNames: [fixture],
          options: {
            noEmit: true,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            moduleDetection: ts.ModuleDetectionKind.Force,
            skipLibCheck: true,
            types: [],
            // THE POINT OF THE TEST: the real thing, not a hand-written stub.
            lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
          },
        })

        const diagnostics = [
          ...program.getSemanticDiagnostics(),
          ...program.getSyntacticDiagnostics(),
        ].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)

        expect(
          diagnostics.map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
          ),
        ).toStrictEqual([])
      }),
    30_000,
  )

  it.effect('the shipped project still compiles with NO DOM at all', () =>
    Effect.sync(() => {
      // The other half of the proof, and the load-bearing one. `pnpm typecheck`
      // runs `tsconfig.build.json`, which must still say `lib: ["ES2024"]` and
      // `types: []` — WITH the adapter inside it. If a later change adds "DOM"
      // there, every module in `domain/` silently becomes able to reach
      // `window` and `localStorage`, and the reason this toolkit can be used
      // from a worker or a server is gone with no test going red.
      const config = ts.readConfigFile(
        path.join(repositoryRoot, 'tsconfig.build.json'),
        ts.sys.readFile,
      )
      const parsed = ts.parseJsonConfigFileContent(config.config as unknown, ts.sys, repositoryRoot)

      expect(parsed.options.lib).toStrictEqual(['lib.es2024.d.ts'])
      expect(parsed.options.types).toStrictEqual([])
      expect(
        parsed.fileNames.some((file) => file.endsWith('domain/indexeddb-storage.ts')),
      ).toBe(true)
      expect(parsed.fileNames.some((file) => file.includes('/test/fixtures/'))).toBe(false)
    }),
  )
})
