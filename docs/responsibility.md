# Responsibility boundaries

## What mc-save owns

- Effect 4 schema codecs and strict format-version checks
- Save envelopes, canonical encoding, integrity checks, and byte-size limits
- `StoragePort` and in-memory and IndexedDB adapters
- Single, batch, durable, retry, and revisioned persistence operations
- Generic sequential write-queue mechanics
- Save-slice bundle encoding, decoding, migration-path resolution, and restore preflight
- `SaveKey` validation and shared world-key layout
- Minecraft Java NBT, modified UTF-8, compression, Anvil region, and external `.mcc` wire formats
- Standard Minecraft Java save-path helpers

mc-save owns the boundary that encodes values, checks stored data, and sends it to storage. It does not define which game values a consumer saves. Values read from storage and other unknown inputs are treated as untrusted and validated again.

## What mc-kernel owns

mc-save reuses shared values and contracts from `@nerima-games/mc-kernel` instead of defining equivalents:

- `WorldId` from the package root
- `ChunkCoord`, `ChunkAxis`, `CHUNK_SIZE_XZ`, and `chunkCoord` from `@nerima-games/mc-kernel/domain/coordinates`
- `SaveSliceId`, `SaveVersion`, and their schemas from `@nerima-games/mc-kernel/domain/module-contracts`
- `SaveMigration`, `defineSaveMigration`, and `SaveSliceRegistration` from `@nerima-games/mc-kernel/domain/save-slices`

This keeps coordinate brands and save-slice contracts consistent across persistence, simulation, and world-generation packages. mc-save does not import kernel game semantics or clock behavior.

## What consumers own

- Game-specific schemas and validation for players, chunks, and world metadata
- Save timing, autosave policy, and conversion into domain objects after restore
- Simulation state and callback policy around settings writes
- Composition of save-slice registrations; the owning package remains to be confirmed in the downstream plan
- Private world session lifecycle, host registration, browser wiring, and UI feedback
- The format names and versions a product supports

Consumers define their schemas and use `defineFormat`, `saveTo`, `loadFrom`, or the durable APIs. A consumer can use the generic write queue and revisioned-save operation without moving product-specific state or session behavior into mc-save.

## Ownership handoff

| Concern | mc-save | Consumer owner |
|---|---|---|
| `enqueueSettingsWrite` / `drainSettingsWrites` | Sequential write-queue mechanics | mc-sim keeps settings state and callbacks |
| `saveSession` | Generic revision writes, rollback, and obsolete-revision cleanup in `src/application/revisioned-save.ts` | mc-compose keeps the typed session wrapper |
| Player settings persistence | Generic format and storage operations | mc-sim keeps the format name, key, schema, defaults, and settings meaning |
| Platform adapters and session errors | Generic storage adapters only | mc-host-web keeps browser wiring, platform adapters, database/session constants, and host-specific errors |
| Save-slice bundle | Bundle codec, migrations, and preflight before any restore is called | mc-sim supplies slice state; the package that composes registrations remains to be confirmed; mc-host-web owns private session lifecycle and host registration |

For legacy restore, mc-save validates the version-3 outer envelope against the `SaveFormat.name` chosen by the consumer and checks its integrity metadata. mc-sim converts the validated payload into current slice and domain state. mc-save does not create or close world sessions. mc-host-web verifies that restore happens in a private session and that the host registers it only after successful completion.

## Package and downstream coverage map

Each ledger key links a package-level check to the downstream end-to-end check that covers the consuming application boundary.

| Ledger key | mc-save package coverage | Downstream end-to-end coverage |
|---|---|---|
| `parity/survival/save-load` | `test/format-roundtrip.test.ts` and `test/migration.test.ts` | `e2e/persistence.e2e.ts` in mc-compose after mc-save 0.6.0 is published and pinned |
| `perf/fr-2.3` | `test/indexeddb-storage.test.ts`, the IndexedDB browser contract, and `pnpm bench:durable-save` for performance evidence | `e2e/persistence.e2e.ts` in mc-compose after the same downstream update |

The mc-save browser suite verifies the real IndexedDB adapter boundary. The mc-compose end-to-end suite depends on the published package and pinned version, so it runs in the consumer repository after this package is released.

## Dependency direction

```text
mc-kernel ─────────────> mc-save ─────────────> effect
consumer application ──> mc-save
```

Consumers import and call mc-save, passing schemas and values as runtime inputs. Those values are not package dependencies. mc-save does not import consumer domain modules. `.oxlintrc.json` and `src/index.ts` enforce the production-import and public-export boundaries.
