# Public API

The package exports its public API from `src/index.ts`. Internal modules that are not re-exported are not part of the package contract.

## Formats and envelopes

`defineFormat` validates a format name and positive safe-integer version. It returns a `Result` from Effect; handle its failure before passing the format to other APIs. `defineFormatMigration` validates a migration step's source version and transform. Pass a contiguous migration chain through `defineFormat({ migrations })`; each step receives the value decoded by its source schema and returns the next version's encoded payload. `decodeSave` decodes the final payload with the current schema. Future versions and older versions without a complete chain fail with `SaveDecodeError`. `encodeSave` always writes the current format version.

`sealSaveEnvelope` validates and seals an envelope synchronously through `Result`. `validateSaveEnvelope` checks an untrusted envelope and its integrity through an Effect. The default encoded-size limit is `DEFAULT_MAX_SAVE_BYTES`; persistence read and write options can override the applicable limit.

`saveEnvelope` creates a draft. `SaveEnvelopeSchema` and `SaveEnvelopeDraftSchema` validate the corresponding wire shapes. The envelope contains the format name, version, payload, optional extensions, and, once sealed, integrity metadata.

`undefinedFieldsAsNull`, `encodeUndefinedAsNull`, and `restoreNullAsUndefined` handle explicitly named fields whose domain value may be `undefined`. They do not recursively change unrelated `null` values or array elements.

## Persistence and storage

The main operations are `saveTo`, `loadFrom`, and `listFrom`. They use the `StoragePort` Effect service:

- `saveTo` encodes, seals, validates, then writes one value.
- `loadFrom` validates read options before storage lookup, returns `Option.none()` only for a missing key, and revalidates stored data before decoding it.
- `SaveReadOptions.record` identifies a failing load as a save, head, or chunk; `repair` lets a wrapper provide recovery facts. Save and head reads check for a decodable durable previous value by default; chunk reads default to no retained revision.
- `listFrom` validates read options before enumerating keys, then returns valid values and per-key decode failures separately. Invalid options and storage failures fail the whole listing; its `corrupt` partition contains decode failures and does not mean every save is safe to delete.
- Decode failures identify the affected save record and include repair guidance. Listing entries omit error causes, which may contain payload data.
- `saveBatch` prepares every entry before one atomic `commitBatch` call.
- `saveDurably` and `loadDurably` use a previous-value key for recovery.
- `withStorageRetry` wraps the storage service with a `StorageRetryPolicy`.
- `writeRevisionedSave` publishes chunks before the head, attempts to restore prior values after a typed write failure, and best-effort removes obsolete chunks after publication.
- `writeRevisionedSaveWithCheckpoint` retains the validated prior revision under caller-defined revision-specific keys before publishing the replacement. `readRevisionedSave` and `loadRetainedRevision` return valid chunks plus per-chunk decode failures, with the actual stored chunk keys in repair metadata.
- `makeWriteQueue` serializes writes. `enqueue` schedules a write; `drain` waits for queued writes and reports the most recent failure not yet observed by `drain`. A later success does not erase that failure.

`StoragePort` exposes `get`, `put`, `remove`, `commitBatch`, `readBatch`, and `keys`. The package provides `makeInMemoryStorage`, `InMemoryStorageLayer`, `makeIndexedDbStorage`, `indexedDbStorageLayer`, and `failingStorageLayer`. Both adapters reject malformed envelope values and sparse or `undefined` batch arrays with `StorageError`; they keep valid empty batches and missing keys distinct.

`SaveKey` is a branded key type. For untrusted strings, call `SaveKey.result(raw)` and propagate the `BrandError` before using `.success`. `saveKeyForWorld` already returns `Result<SaveKey, ValidationMessage>`; handle that Result directly.

## Save-slice bundles

The save-slice bundle API uses the contracts from `@nerima-games/mc-kernel`:

- `encodeSaveBundle` snapshots and encodes registered slices.
- `decodeSaveBundle` clones and validates an unknown bundle.
- `resolveSaveMigrationPath` finds a unique forward migration path or returns a typed missing/ambiguous-path error.
- `restoreSaveBundle` validates registration coverage, applies migrations, and decodes every slice before calling any restore callback.

Bundle operations expose typed errors for malformed snapshots, missing entries, unregistered slices, missing or ambiguous migration paths, schema errors, and errors from the consumer's restore callbacks. The migration contracts and branded IDs are defined by the kernel; mc-save does not provide local copies.

## Registry and errors

`emptyRegistry`, `registerFormat`, `registerFormats`, `lookupFormat`, and `describeRegistry` provide immutable format registration. Registration returns a `Result` and rejects duplicate names with `DuplicateFormatError`.

Persistence and codec failures use tagged errors such as `StorageError`, `SaveDecodeError`, `MinecraftJavaSaveError`, `MinecraftCompressionError`, `NbtFormatError`, and `AnvilRegionError`. Pure validation helpers and byte codecs may return `Result`; Effectful codecs and storage operations return typed Effects. `minecraftJavaSaveError` and `errorReason` return `Result` values, so formatting or brand failures remain visible in the failure channel.

## Minecraft Java codecs

The package exports codecs for Java modified UTF-8, NBT, gzip/zlib/none/LZ4 compression, Anvil regions, and external `.mcc` chunks. File-level functions encode and decode the supported Minecraft Java save files while preserving unknown NBT fields. Path helpers cover level metadata, player data, stats, advancements, map and world data files, structures, resource packs, and region/entity/POI storage.

Key codec entry points and return types are:

- `encodeMinecraftJavaSave(save, options?)` returns `Effect.Effect<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveError | TypeError>`; `decodeMinecraftJavaSave(files, options?)` returns `Effect.Effect<MinecraftJavaSave, MinecraftJavaSaveError | TypeError>`.
- `validateMinecraftJavaSave(save, resolvedOptions)` and `validateMinecraftJavaSaveFiles(files, resolvedOptions)` return `Result.Result` values with `MinecraftJavaSaveError | TypeError`; `resolveMinecraftJavaSaveOptions(options?)` validates user options and returns the resolved options in `Result.Result<ResolvedMinecraftJavaSaveOptions, MinecraftJavaSaveError | TypeError>`.
- `encodeNbt(document, options?)` and `decodeNbt(bytes, options?)` return `Result.Result` values with `NbtFormatError`.
- `encodeMinecraftNbtFile(document, options?)` and `decodeMinecraftNbtFile(bytes, options?)` return `Effect.Effect` values with NBT, compression, LZ4, or type errors.
- `compressMinecraft(bytes, compression, options?)` and `decompressMinecraft(bytes, compression, options?)` return `Effect.Effect` values with compression or LZ4 errors.
- `encodeMinecraftSessionLock(value)` and `decodeMinecraftSessionLock(bytes)` return `Result.Result` values with `TypeError` on invalid values or bytes.

Coordinate operations use `ChunkCoord`, `ChunkAxis`, `CHUNK_SIZE_XZ`, and `chunkCoord` from `@nerima-games/mc-kernel/domain/coordinates`. `WorldId` is imported from the kernel package root. These types are not redefined by mc-save.

The codecs validate byte, file-count, and total-size limits. They preserve supported unknown wire data but do not define game-specific player or chunk schemas. Anvil compression ID `127` is retained as a custom algorithm payload; mc-save does not decompress an arbitrary custom algorithm.

## 0.6 declaration comparison

The exhaustive packaged declaration comparison is in [`docs/api-migration-0.6.0.md`](./api-migration-0.6.0.md). It includes all changed callable and constructor signatures; exported interface, type alias, and class members; union variant fields; exported constant types; field presence and mutability; class heritage; index signatures; and checked construction paths for the new brands.
