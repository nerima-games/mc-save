# Design notes

## DN-1: Format versions require an exact match

`decodeSave` checks the format name and version. It rejects future versions and versions other than the current one. Implicitly reading an older payload would make conversions hard to trace and complicate recovery after a failed migration. Consumers define a new format and own any explicit conversion.

## DN-2: Keep draft and sealed envelopes separate

`encodeSave` returns a schema-encoded draft. Persistence preparation checks canonical bytes, checksum, and size before producing a sealed envelope. Storage APIs accept only the sealed type, so unchecked values do not cross the persistence boundary.

## DN-3: Canonical bytes define integrity

The checksum is calculated over the envelope's canonical representation, not the payload's meaning. Encoding, sealing, decoding, and IndexedDB records use the same canonical bytes so integrity does not depend on object identity or property insertion order.

## DN-4: Revalidate values read from storage

Although `StoragePort` is typed to return an envelope, the runtime value came from IndexedDB or another external medium. `loadFrom` validates the envelope schema, size, checksum, format, and payload schema. `listFrom` records per-save decode failures in the listing, while invalid read options and storage failures fail the Effect.

## DN-5: Atomic batches belong to the port

`commitBatch` validates each mutation and retains the pre-change snapshot if a mutation fails. Batch preparation belongs to the codec and commit atomicity belongs to the adapter, which keeps IndexedDB and in-memory behavior aligned.

## DN-6: Durable recovery keys stay out of normal listings

`saveDurably` reads the envelope at the head key. When it decodes as the current format, one atomic `commitBatch` writes that envelope to `durablePreviousKey(key)` and the new sealed envelope to the head key. If there is no valid current head, it writes only the new head; a future-version head fails rather than being overwritten. Normal listings omit the recovery key, which lets `loadDurably` recover after an interrupted update without treating recovery as a format migration.

## DN-7: Retry policy wraps the port

`withStorageRetry` applies one schedule and predicate to port operations. Whether a failure can be retried depends on the adapter, so callers inject a `StorageRetryPolicy`. Keeping retry at the port wrapper prevents `put` and batch operations from drifting apart.

## DN-8: Java codecs do not interpret game semantics

Modified UTF-8, NBT, and compression implement Java wire formats. Consumers decide which NBT schemas and tags their game uses; mc-save does not import a world or player model. Codec options expose limits for depth, size, and string length.

## DN-9: Validate Anvil byte layout

Anvil regions contain a 32 by 32 chunk index, an 8 KiB header, records allocated in 4 KiB sectors, compression identifiers, payload lengths, and padding. Oversized payloads can use external `.mcc` records. Region, entity, and POI paths use the same container layer.

## DN-10: Keep path and coordinate calculations pure

Dimension directories, region coordinates, floor division for negative coordinates, local coordinates within a region, and path-segment validation are centralized in `minecraft-paths.ts`. Coordinate types and chunk size come from `mc-kernel` so consumers do not reimplement those rules.

## DN-11: Publish revisioned data by publishing the head last

`writeRevisionedSave` writes chunks before the head so readers do not observe a head that points to unpublished chunks. After a typed write failure it attempts to restore the previous head and chunk values. Once the new head is written, obsolete chunk cleanup is best-effort.

## DN-12: Preflight every save slice before restoring any slice

`restoreSaveBundle` clones and validates the input, checks registration coverage, resolves a unique forward migration path, applies migrations, and decodes every registered slice before invoking a restore callback. A malformed bundle or migration failure therefore cannot leave some slices restored and others untouched. Consumer callbacks and session lifecycle remain outside mc-save.

## DN-13: Keep the write queue generic

`makeWriteQueue` provides serial write mechanics without owning settings state, callbacks, or session behavior. Later writes run after typed failures. The most recent typed failure remains pending through later successes. `drain` waits for queued writes, reports that failure, and clears it; a newer failure replaces an older pending failure.

## Regression tests

The tests for these decisions include:

- Format and integrity: `test/format-roundtrip.test.ts`, `test/durable-save.test.ts`, and `test/migration.test.ts`
- Batch, port, retry, and revision writes: `test/batch-save.test.ts`, `test/storage-port.test.ts`, `test/storage-retry.test.ts`, and `test/revisioned-save.test.ts`
- Save-slice bundles and queue: `test/save-slices.test.ts`, `test/save-migration-path.test.ts`, and `test/write-queue.test.ts`
- IndexedDB layout and runtime: `test/indexeddb-*.test.ts` and `test/browser/`
- Java codecs: `test/minecraft-*.test.ts`, `test/anvil-region.test.ts`, and `test/minecraft-region-files.test.ts`
- Paths and keys: `test/minecraft-paths.test.ts` and `test/save-key.test.ts`
