/**
 * @nerima-games/mc-save — the persistence toolkit.
 *
 * The public entry point for the persistence toolkit.
 *
 * mc-save is a stable persistence library with a narrow interface. It provides
 * current-version application formats, storage ports, and lossless Java
 * NBT/Anvil codecs plus a typed file-level boundary for official Minecraft
 * saves. Version-specific game semantics remain in NBT documents so unknown
 * fields survive a read/write cycle.
 *
 * The storage service has no dependency on game-domain modules, so persistence
 * and world generation remain separate. The Java save façade covers the
 * official on-disk file categories without coupling IndexedDB to world logic.
 *
 * The IndexedDB adapter ships from here too, and it does NOT cost the toolkit
 * its platform-freedom. `tsconfig.base.json` still says `lib: ["ES2024"]` with
 * no `"DOM"`: the adapter is written against a narrow structural description of
 * IndexedDB (`domain/indexeddb-surface.ts`) which is PROVED to be a subset of
 * the real one by compiling a fixture against `lib.dom.d.ts`. So mc-save can be
 * handed a real `indexedDB` in a browser and still typecheck as a library that
 * has never heard of a browser.
 */

export * from './domain/envelope.js'
export * from './domain/binary.js'
export * from './domain/batch-save.js'
export * from './domain/durable-save.js'
export * from './domain/errors.js'
export * from './domain/format.js'
export * from './domain/indexeddb-storage.js'
export * from './domain/indexeddb-surface.js'
export * from './domain/anvil-region.js'
export * from './domain/minecraft-compression.js'
export * from './domain/minecraft-java-save-decode.js'
export * from './domain/minecraft-java-save-encode.js'
export * from './domain/minecraft-java-save-errors.js'
export * from './domain/minecraft-java-save-json.js'
export * from './domain/minecraft-java-save-paths.js'
export * from './domain/minecraft-java-save-types.js'
export * from './domain/minecraft-java-save-validation.js'
export * from './domain/minecraft-lz4.js'
export * from './domain/minecraft-nbt.js'
export * from './domain/minecraft-nbt-compression.js'
export * from './domain/minecraft-save-files.js'
export * from './domain/minecraft-paths.js'
export * from './domain/minecraft-region-files.js'
export * from './domain/optional-fields.js'
export * from './domain/persistence.js'
export * from './domain/registry.js'
export * from './domain/save-key.js'
export * from './domain/storage-port.js'
export * from './domain/storage-retry.js'
