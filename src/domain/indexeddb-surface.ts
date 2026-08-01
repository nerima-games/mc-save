/**
 * THE ENTIRE INDEXEDDB SURFACE THIS REPOSITORY DEPENDS ON, IN ONE FILE.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists instead of `"lib": ["ES2024", "DOM"]`
 * ---------------------------------------------------------------------------
 *
 * `tsconfig.base.json` ships `lib: ["ES2024"]` and `types: []`, and its comment
 * names this adapter as the one thing that would add `"DOM"`. Adding it would
 * work, and it would cost the property the whole repository is arranged around:
 * `pnpm typecheck` over `tsconfig.build.json` is currently a PROOF that the
 * codec toolkit is platform-free. With `"DOM"` on, `domain/format.ts` could
 * reach for `localStorage` and `domain/persistence.ts` could reach for `window`,
 * and nothing would notice for months — mc-save would still typecheck, still
 * test green, and would have quietly stopped being usable from a worker or a
 * server. `index.ts` says mc-save "has no opinion about what is being saved";
 * a DOM-wide lib is the same mistake one level down, about WHERE.
 *
 * `docs/responsibility.md` (§ the risk table) proposed isolating the adapter in
 * a second tsconfig instead. That is rejected here on a mechanical consequence
 * rather than on taste, the same one mc-render found. At the time this
 * decision was made, `scripts/api-lock.ts` built its report from
 * `REPOSITORY_POLICY.tsconfigFile` = `tsconfig.build.json`, and
 * `scripts/check-dependency-whitelist.ts` classified shipped source as
 * `index.ts` plus `domain/` (both scripts have since been retired in favour of
 * org-standard tooling — see docs/testing.md — but the shipped-source
 * boundary they enforced is now `tsconfig.build.json` / `.oxlintrc.json`'s `src`
 * target, and the argument is unchanged). An adapter outside
 * `tsconfig.build.json` could not be re-exported from `src/index.ts` without
 * silently falling outside every gate that scans shipped source — so the one
 * file in this repository that talks to a real medium would be the one file
 * no gate could see.
 *
 * So: DESCRIBE, structurally, the handful of IndexedDB members the adapter
 * actually uses. mc-render did this for `window` and `document`
 * (`application/dom-surface.ts`) and mx-ui for `Document` and `HTMLElement`;
 * this is the same move for `IDBFactory`.
 *
 * ---------------------------------------------------------------------------
 * The property that makes it safe, and how it is proved
 * ---------------------------------------------------------------------------
 *
 * A hand-written structural type is only useful if a REAL `indexedDB` satisfies
 * it WITHOUT A CAST. `test/fixtures/indexeddb-surface.ts` is compiled BY A TEST
 * against the real `lib.dom.d.ts` and asserted to produce zero diagnostics, so
 * that claim is checked by CI rather than asserted in this comment. It is the
 * other half of a proof whose first half is `pnpm typecheck`: the build project
 * still compiles with no `lib.DOM` at all, so no file here can have grown a
 * `window` reference.
 *
 * ---------------------------------------------------------------------------
 * Why every event handler takes `never`, which looks like a mistake
 * ---------------------------------------------------------------------------
 *
 * This is the one non-obvious thing in the file, and it is not stylistic.
 *
 * lib.dom declares these slots as PROPERTIES holding functions —
 * `onsuccess: ((this: IDBRequest<T>, ev: Event) => any) | null`. Under
 * `strictFunctionTypes` a function-typed property is checked CONTRAVARIANTLY in
 * its parameter, so for a real `IDBRequest` to be assignable to the type below,
 * OUR parameter type must be assignable to `Event` — that is, our event type
 * must be a SUBTYPE of the DOM's, not a supertype. The only subtype of `Event`
 * that can be written without `lib.dom` is `never`.
 *
 * Both obvious alternatives were compiled against the real `lib.dom.d.ts` and
 * both are rejected by the compiler, with these exact messages:
 *
 *   onsuccess: (() => void) | null
 *     → "Target signature provides too few arguments. Expected 1 or more,
 *        but got 0."
 *
 *   onupgradeneeded: ((event: { readonly oldVersion?: number }) => void) | null
 *     → "Type '{ oldVersion?: number }' is missing the following properties
 *        from type 'IDBVersionChangeEvent': newVersion, bubbles, cancelBubble,
 *        cancelable, and 19 more."
 *
 * Note what the second one means: THE EVENT CANNOT BE READ. `event.oldVersion`
 * is not available to the upgrade handler through this surface.
 *
 * That is a feature, and it is the reason this shape was chosen over the one
 * that would have worked. `addEventListener` flips the variance — its listener
 * parameter is checked against `EventListener = (evt: Event) => void`, so an
 * all-optional supertype IS accepted there (that is precisely how mc-render's
 * `DomInputEvent` reads `event.code`), and `oldVersion` would have been
 * readable. It was rejected because `docs/public-api.md` §8 states the rule
 * this repository is built on:
 *
 *   > mc-save ではスキーマ移行は `defineFormat` の連鎖が担い、
 *   > IndexedDB の `upgrade` はストア構造の変更だけに限定する（責務を混ぜない）。
 *
 * The reference implementation broke that rule by accident and got away with
 * it: `idb-utils.ts:222` passed `event.oldVersion` to a callback whose only
 * caller (`storage-service.ts:55-62`) discarded the argument, so its data-rewrite
 * path never ran once in production. Making the event unreadable turns "do not
 * branch the upgrade on the old version" from a convention someone must
 * remember into something the type system refuses to express.
 *
 * If a future layout change genuinely needs the old version, the fix is NOT to
 * widen this parameter — it is to reconsider, and only then to move that one
 * slot to `addEventListener` and say why in this header.
 */

/**
 * `DOMException`, reduced to the two members the error mapping reads.
 *
 * `name` carries the whole classification — `QuotaExceededError`,
 * `ConstraintError`, `AbortError`, `VersionError` — and the reference
 * implementation identified quota the same way
 * (`storage-error-mapping.ts`, recorded in `docs/public-api.md` §8:
 * "`QuotaExceededError` は `DOMException.name` で判定"). Both members are
 * REQUIRED rather than optional: `DOMException` really does declare both, and a
 * type whose members are all optional is a "weak type" that TypeScript refuses
 * to accept an unrelated source for.
 *
 * `code` is deliberately absent. It is the deprecated numeric legacy of the
 * same information, and reading it would give the mapping a second, older
 * spelling of a question `name` already answers.
 */
export type IdbDomException = {
  readonly name: string
  readonly message: string
}

/**
 * The result of one IndexedDB operation.
 *
 * `result` is `unknown` and not a payload type, because it genuinely is: what
 * comes back is whatever some earlier build — or some other tab — wrote. The
 * adapter narrows it at the boundary rather than asserting it, which is the
 * rule `domain/persistence.ts` already states for the envelope ("the bytes came
 * from outside this process, and a type annotation is not a runtime guarantee").
 *
 * Reading `result` before the success handler fires throws `InvalidStateError`
 * in a real browser, so the adapter only ever touches it inside `onsuccess`.
 * That is a discipline this type cannot enforce; it is enforced by there being
 * exactly one helper (`requestResult`) that reads it.
 *
 * The handler slots are NOT `readonly`: they are assigned to, which is how this
 * API is driven. Every other member here is `readonly`, so the mutability is
 * visibly confined to the four slots that need it.
 */
export type IdbRequest = {
  readonly result: unknown
  readonly error: IdbDomException | null
  onsuccess: ((event: never) => void) | null
  onerror: ((event: never) => void) | null
}

/**
 * The request returned by `open`, which has two extra outcomes.
 *
 * `onblocked` fires when another connection is still holding the database at an
 * older version. It is NOT an error in the DOM's eyes — the open simply stays
 * pending until the other connection closes, possibly forever. See
 * `openDatabase` for why this adapter refuses to wait.
 */
export type IdbOpenRequest = IdbRequest & {
  readonly result: IdbDatabase
  onupgradeneeded: ((event: never) => void) | null
  onblocked: ((event: never) => void) | null
}

/**
 * `DOMStringList`, as `objectStoreNames` returns it.
 *
 * Modelled with `contains` rather than by iterating, because the only questions
 * the adapter and its tests ask are "is our store there" and "what is in this
 * database". `DOMStringList` is not declared iterable in `lib.dom.d.ts`, so
 * spreading it would not have compiled against the real thing anyway — the
 * fixture would have caught it.
 */
export type IdbStringList = {
  readonly length: number
  readonly contains: (name: string) => boolean
  readonly item: (index: number) => string | null
}

/** An index over an object store. Used for one thing; see `INSERTION_INDEX`. */
export type IdbIndex = {
  /**
   * The PRIMARY keys of the matching records, in this index's key order.
   *
   * Not the index keys — the primary ones. That is what makes a single request
   * enough to answer `StoragePort.keys` in insertion order.
   */
  readonly getAllKeys: (query?: null, count?: number) => IdbRequest
  /**
   * A cursor, used only in the `'prev'` direction to find the largest key.
   *
   * `query` is only ever `null` and `direction` only ever `'prev'`, so both are
   * spelled as narrowly as they are used. A wider spelling would be a wider
   * thing for the fake in `test/fake-indexeddb.ts` to have to stand in for.
   */
  readonly openCursor: (query?: null, direction?: 'prev') => IdbRequest
}

/**
 * One object store.
 *
 * `get`, `put` and `delete` are keyed by `string` only, because `SaveKey` is a
 * branded string and this adapter has no other kind of key. The real signatures
 * accept `IDBValidKey | IDBKeyRange`; a narrower parameter is fine (and proved
 * fine by the fixture), and it keeps the fake from having to implement key
 * ranges it would never be asked for.
 */
export type IdbObjectStore = {
  readonly get: (key: string) => IdbRequest
  /** In-line keys: the record carries its own key at `keyPath`, so no second argument. */
  readonly put: (value: unknown) => IdbRequest
  readonly delete: (key: string) => IdbRequest
  readonly index: (name: string) => IdbIndex
  readonly createIndex: (name: string, keyPath: string) => unknown
}

/**
 * A transaction.
 *
 * All three completion slots are modelled because all three are distinguishable
 * outcomes the adapter must report differently:
 *
 *   - `oncomplete` — the write is durable. ONLY here may a write be reported as
 *     having succeeded. A `put` request firing `onsuccess` means the value
 *     reached the transaction, not the disk; the reference implementation
 *     resolved on the request (`idb-utils.ts`) and therefore told the caller a
 *     save had happened while it could still be rolled back.
 *   - `onerror` — a request failed and the transaction is unwinding.
 *   - `onabort` — the transaction was rolled back, possibly by the browser
 *     under storage pressure and possibly with `error` null.
 */
export type IdbTransaction = {
  readonly objectStore: (name: string) => IdbObjectStore
  readonly abort: () => void
  readonly error: IdbDomException | null
  oncomplete: ((event: never) => void) | null
  onerror: ((event: never) => void) | null
  onabort: ((event: never) => void) | null
}

export type IdbDatabase = {
  readonly name: string
  readonly version: number
  readonly objectStoreNames: IdbStringList
  readonly createObjectStore: (
    name: string,
    options?: { readonly keyPath?: string },
  ) => IdbObjectStore
  readonly transaction: (storeNames: string, mode?: 'readonly' | 'readwrite') => IdbTransaction
  readonly close: () => void
  /**
   * Fires when ANOTHER connection wants to upgrade this database.
   *
   * Handled rather than ignored, because ignoring it is what produces the
   * `onblocked` above in the other tab: a connection that does not close on
   * `versionchange` blocks every future version of the game from opening at all,
   * and the player sees a title screen that never loads.
   */
  onversionchange: ((event: never) => void) | null
}

/**
 * `indexedDB` itself.
 *
 * `databases()` is OPTIONAL, and honestly so: it is absent in Firefox, and the
 * adapter therefore never calls it. It is here because the port of E2E triage
 * row #9 asks the question that method exists to answer — "is there a database
 * with this name" — and a surface file that claims to be everything this
 * repository depends on has to include what the tests depend on too.
 */
export type IdbFactory = {
  readonly open: (name: string, version?: number) => IdbOpenRequest
  readonly databases?: () => Promise<
    ReadonlyArray<{ readonly name?: string; readonly version?: number }>
  >
}
