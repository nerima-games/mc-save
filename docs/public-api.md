# Public API

The package exports its public API from `src/index.ts`. Internal modules that are not re-exported are not part of the package contract.

## Formats and envelopes

`defineFormat` validates a format name and positive safe-integer version. It returns a `Result` from Effect; handle its failure before passing the format to other APIs. `encodeSave` encodes a typed value and returns an Effect with a `SaveEnvelopeDraft`. `decodeSave` accepts only the format's current version and returns a typed Effect. It does not migrate older payloads.

`sealSaveEnvelope` validates and seals an envelope synchronously through `Result`. `validateSaveEnvelope` checks an untrusted envelope and its integrity through an Effect. The default encoded-size limit is `DEFAULT_MAX_SAVE_BYTES`; persistence read and write options can override the applicable limit.

`saveEnvelope` creates a draft. `SaveEnvelopeSchema` and `SaveEnvelopeDraftSchema` validate the corresponding wire shapes. The envelope contains the format name, version, payload, optional extensions, and, once sealed, integrity metadata.

`undefinedFieldsAsNull`, `encodeUndefinedAsNull`, and `restoreNullAsUndefined` handle explicitly named fields whose domain value may be `undefined`. They do not recursively change unrelated `null` values or array elements.

## Persistence and storage

The main operations are `saveTo`, `loadFrom`, and `listFrom`. They use the `StoragePort` Effect service:

- `saveTo` encodes, seals, validates, then writes one value.
- `loadFrom` returns `Option.none()` for a missing key and revalidates stored data before decoding it.
- `listFrom` returns valid values and per-key decode failures separately. A storage failure fails the whole listing.
- `saveBatch` prepares every entry before one atomic `commitBatch` call.
- `saveDurably` and `loadDurably` use a previous-value key for recovery.
- `withStorageRetry` wraps the storage service with a `StorageRetryPolicy`.
- `writeRevisionedSave` publishes chunks before the head, attempts to restore prior values after a typed write failure, and best-effort removes obsolete chunks after publication.
- `makeWriteQueue` serializes writes. `enqueue` schedules a write; `drain` waits for queued writes and reports the last typed failure.

`StoragePort` exposes `get`, `put`, `remove`, `commitBatch`, `readBatch`, and `keys`. The package provides `makeInMemoryStorage`, `InMemoryStorageLayer`, `makeIndexedDbStorage`, `indexedDbStorageLayer`, and `failingStorageLayer`.

`SaveKey` is a branded key type. Values from untrusted input should be checked with the brand constructor's `option` or `result` method rather than an unsafe cast. `saveKeyForWorld` builds a key from the kernel's `WorldId` and encoded path segments.

## Save-slice bundles

The save-slice bundle API uses the contracts from `@nerima-games/mc-kernel`:

- `encodeSaveBundle` snapshots and encodes registered slices.
- `decodeSaveBundle` clones and validates an unknown bundle.
- `resolveSaveMigrationPath` finds a unique forward migration path or returns a typed missing/ambiguous-path error.
- `restoreSaveBundle` validates registration coverage, applies migrations, and decodes every slice before calling any restore callback.

Bundle operations expose typed errors for malformed snapshots, missing entries, unregistered slices, missing or ambiguous migration paths, schema errors, and errors from the consumer's restore callbacks. The migration contracts and branded IDs are defined by the kernel; mc-save does not provide local copies.

## Registry and errors

`emptyRegistry`, `registerFormat`, `registerFormats`, `lookupFormat`, and `describeRegistry` provide immutable format registration. Registration returns a `Result` and rejects duplicate names with `DuplicateFormatError`.

Persistence and codec failures use tagged errors such as `StorageError`, `SaveDecodeError`, `MinecraftJavaSaveError`, `MinecraftCompressionError`, `NbtFormatError`, and `AnvilRegionError`. Pure validation helpers and byte codecs may return `Result`; Effectful codecs and storage operations return typed Effects. No public Minecraft Java save helper throws a domain error for invalid input.

## Minecraft Java codecs

The package exports codecs for Java modified UTF-8, NBT, gzip/zlib/none/LZ4 compression, Anvil regions, and external `.mcc` chunks. File-level functions encode and decode the supported Minecraft Java save files while preserving unknown NBT fields. Path helpers cover level metadata, player data, stats, advancements, map and world data files, structures, resource packs, and region/entity/POI storage.

Key codec entry points and return types are:

- `encodeMinecraftJavaSave(save, options?)` returns `Effect.Effect<ReadonlyArray<MinecraftJavaSaveFile>, MinecraftJavaSaveError>`; `decodeMinecraftJavaSave(files, options?)` returns `Effect.Effect<MinecraftJavaSave, MinecraftJavaSaveError>`.
- `validateMinecraftJavaSave(save, resolvedOptions)` and `validateMinecraftJavaSaveFiles(files, resolvedOptions)` return `Result.Result` values with `MinecraftJavaSaveError`; `resolveMinecraftJavaSaveOptions(options?)` validates user options and returns the resolved options in a `Result`.
- `encodeNbt(document, options?)` and `decodeNbt(bytes, options?)` return `Result.Result` values with `NbtFormatError`.
- `encodeMinecraftNbtFile(document, options?)` and `decodeMinecraftNbtFile(bytes, options?)` return `Effect.Effect` values with NBT, compression, LZ4, or type errors.
- `compressMinecraft(bytes, compression, options?)` and `decompressMinecraft(bytes, compression, options?)` return `Effect.Effect` values with compression or LZ4 errors.
- `encodeMinecraftSessionLock(value)` and `decodeMinecraftSessionLock(bytes)` return `Result.Result` values with `TypeError` on invalid values or bytes.

Coordinate operations use `ChunkCoord`, `ChunkAxis`, `CHUNK_SIZE_XZ`, and `chunkCoord` from `@nerima-games/mc-kernel/domain/coordinates`. `WorldId` is imported from the kernel package root. These types are not redefined by mc-save.

The codecs validate byte, file-count, and total-size limits. They preserve supported unknown wire data but do not define game-specific player or chunk schemas. Anvil compression ID `127` is retained as a custom algorithm payload; mc-save does not decompress an arbitrary custom algorithm.
