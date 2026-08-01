/**
 * @nerima-games/mc-save — the persistence toolkit.
 *
 * PRE-AUDIT FIRST CUT (叩き台). See README.md 現状.
 *
 * mc-save is tier 1 of the four-tier architecture (plan.md §2.2): a stable
 * library with a narrow interface and no opinion about what is being saved. It
 * provides a way to *define* a versioned format and a Port to write one
 * somewhere. The chunk format belongs to mc-worldgen, the settings format to
 * whoever owns settings, and so on — each defines its own with `defineFormat`.
 *
 * That inversion is the entire design. In the reference implementation the
 * storage service knew about chunks and about world metadata by name
 * (`packages/world/infrastructure/storage-service.ts:96-139`), so persistence
 * and world generation could not be separated. Here mc-save depends on nobody
 * but mc-kernel, and mc-worldgen depends on mc-save.
 *
 * The IndexedDB adapter ships from here too, and it does NOT cost the toolkit
 * its platform-freedom. `tsconfig.base.json` still says `lib: ["ES2024"]` with
 * no `"DOM"`: the adapter is written against a narrow structural description of
 * IndexedDB (`domain/indexeddb-surface.ts`) which is PROVED to be a subset of
 * the real one by compiling a fixture against `lib.dom.d.ts`. So mc-save can be
 * handed a real `indexedDB` in a browser and still typecheck as a library that
 * has never heard of a browser.
 */

export * from './domain/envelope'
export * from './domain/errors'
export * from './domain/format'
export * from './domain/indexeddb-storage'
export * from './domain/indexeddb-surface'
export * from './domain/persistence'
export * from './domain/registry'
export * from './domain/storage-port'
