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
 */

export * from './domain/envelope'
export * from './domain/errors'
export * from './domain/format'
export * from './domain/persistence'
export * from './domain/registry'
export * from './domain/storage-port'
