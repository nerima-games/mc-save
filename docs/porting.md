# Porting and ownership boundaries

## Reusable layers in mc-save

mc-save owns reusable save and wire format behavior without taking on a consumer's game domain:

- `src/domain/format*.ts`: schema-based formats and strict current-version decoding
- `src/domain/envelope.ts` and `src/domain/integrity*.ts`: envelopes, canonical bytes, checksums, and size validation
- `src/domain/persistence.ts`, `src/domain/batch-save.ts`, and `src/domain/durable-save.ts`: Effect persistence operations
- `src/domain/storage-port.ts` and `src/domain/indexeddb-*.ts`: storage port and IndexedDB adapter
- `src/application/revisioned-save.ts`: generic revision writes, rollback, and cleanup
- `src/application/write-queue.ts`: generic sequential write mechanics
- `src/domain/save-slices.ts`: save-slice bundle codecs, migration paths, and restore preflight
- `src/domain/minecraft-*.ts`, `src/domain/anvil-region.ts`, and `src/domain/minecraft-region-files.ts`: Java wire and container codecs
- `src/domain/minecraft-paths.ts`: save paths and coordinate mapping

These layers provide validated values, bytes, containers, and storage operations. They do not assign game meaning to the data.

## Layers that stay with consumers

Consumers retain:

- Player, chunk, and world metadata schemas and semantic validation
- Tick and autosave policy
- Settings state, settings defaults, and settings callbacks
- Typed session wrappers and save-slice registration composition; confirm the owning package in the downstream plan
- Private world session lifecycle, browser host wiring, and host registration
- Rendering, UI, input, and game rules
- Product-specific decisions for converting legacy payloads into current domain state

The save-slice restore preflight decodes and migrates every registered slice before calling any restore callback. It does not open or publish a world session. mc-host-web owns those lifecycle steps.

## Reusing `mc-kernel`

Save keys and Minecraft path calculations use `WorldId`, `ChunkCoord`, `ChunkAxis`, `CHUNK_SIZE_XZ`, and `chunkCoord` from `@nerima-games/mc-kernel`. Save-slice code uses the kernel's `SaveSliceId`, `SaveVersion`, `SaveMigration`, `defineSaveMigration`, and `SaveSliceRegistration` contracts. mc-save does not copy these brands or contracts into local definitions.

## Consumer integration sequence

1. Define the payload schema and current format with `defineFormat`.
2. Validate the storage key with `SaveKey` or `saveKeyForWorld`.
3. Use `saveTo` and `loadFrom`, adding `saveBatch`, durable persistence, or the revisioned-save operation where the storage contract requires them.
4. Provide `InMemoryStorageLayer` or `indexedDbStorageLayer` for the runtime.
5. For save-slice bundles, mc-sim supplies slice state and mc-save encodes and preflights the bundle. Confirm which downstream package composes the registration list before that integration begins.
6. Use NBT, compression, Anvil, and path codecs directly only when a consumer must handle Java save files.

Keep semantic schemas, defaults, session lifecycle, and host behavior in their consumer packages. Do not import internal helpers or create a second save envelope, storage port, or coordinate brand.
