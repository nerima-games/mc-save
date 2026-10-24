# Migrating to mc-save 0.6.0

This release moves the package to Effect 4 and `@nerima-games/mc-kernel` 0.9.0. It also adds the save-slice bundle boundary. The package release is requested as a minor change through Changesets.

## Dependency update

Use the matching Effect packages at `4.0.5` and `@nerima-games/mc-kernel` at `0.9.0`. The library and its tests use `effect`, `@effect/vitest`, and Vitest 5.0.5. Keep the package's existing TypeScript, Node, pnpm, and Playwright constraints.

## Effect API changes

Pure validation and codec helpers now return Effect `Result` values where failure is synchronous. Effectful codecs, schema operations, persistence, and storage return `Effect` values with typed errors. Replace Effect 3 `Either` handling with `Result` handling, and compose asynchronous work with Effect 4 APIs.

`defineFormat` now returns `Result<SaveFormat, ReadonlyArray<string>>`. Handle invalid names or versions at construction time. `sealSaveEnvelope` also returns `Result`; use `validateSaveEnvelope` when validation belongs in an Effect pipeline. `encodeSave` and `decodeSave` return typed Effects. `assertDefined` returns `Result` and does not throw.

For example, create a format and lift a known-valid result into an Effect pipeline:

```ts
import { Effect, Result, Schema } from 'effect'
import { defineFormat, encodeSave } from '@nerima-games/mc-save'

const format = defineFormat({
  name: 'example/world',
  version: 1,
  schema: Schema.Struct({ seed: Schema.Number }),
})

const encoded = Result.isSuccess(format)
  ? encodeSave(format.success, { seed: 42 })
  : Effect.fail(format.failure)
```

Handle a failed `Result` as an ordinary validation outcome. Do not call a throwing constructor on untrusted persisted data.

## Kernel 0.9 brands

Import `WorldId` from the package root. Import `ChunkAxis`, `ChunkCoord`, `CHUNK_SIZE_XZ`, and `chunkCoord` from `@nerima-games/mc-kernel/domain/coordinates`. Save-slice IDs, versions, migrations, and registrations come from the kernel's module-contract and save-slice subpaths. Remove any consumer-local duplicate brand or save-slice contract.

When reading unknown coordinates or branded values, capture the input once and validate it through the brand's `option` or `result` constructor. Those constructors can fail; do not cast untrusted values or call a direct constructor before validation. Pass checked snapshots onward so a getter cannot return a different value during later use.

## Save format compatibility

`decodeSave` accepts only the format name and version declared by the current `SaveFormat`. It does not upgrade an older payload. To migrate a product's older format, read the envelope, validate it, decode the payload with that old version's schema, transform it in the consumer's domain layer, and encode and seal it with the current format. Keep old schemas and product-specific conversion rules with the consumer.

For legacy version 3, the outer envelope must match the legacy `SaveFormat.name` selected by the consuming application, have version `3`, and contain valid integrity metadata. mc-save rejects other legacy outer versions. This boundary validates and exposes the payload; mc-sim converts it into the current slice and domain state.

For save-slice bundles, register each slice with the kernel's `SaveSliceRegistration` and migrations. `restoreSaveBundle` snapshots the input, checks all registered entries, resolves a unique forward migration path, applies migrations, and decodes every slice before invoking any restore callback. mc-sim supplies slice state. The package that composes registrations remains to be confirmed in the downstream plan. Keep session creation and publication in mc-host-web.

## Behavior that stays with consumers

Keep game-specific schemas, settings defaults, save timing, tick and autosave policy, and conversion to domain state in consumer packages. mc-save owns generic encoding, storage, integrity, revision persistence, save-slice preflight, and Minecraft Java wire and container codecs. The host owns private world session lifecycle and host registration.

The mc-compose persistence end-to-end test runs after mc-save 0.6.0 is published and pinned downstream. The private session restore/register integration test belongs to mc-host-web. These checks are not package compatibility tests in this release candidate.
