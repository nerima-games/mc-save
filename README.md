# @nerima-games/mc-save

`@nerima-games/mc-save` is a TypeScript library for Minecraft save data. It provides strict format codecs, integrity-checked envelopes, storage operations, and Minecraft Java wire and container codecs without owning game-specific schemas or save policy.

## Responsibilities

- Effect 4 format codecs, envelopes, integrity checks, and size limits
- `StoragePort`, in-memory and IndexedDB adapters, batch and durable operations, retries, revision writes, and a sequential write queue
- Save-slice bundle encoding, migration-path resolution, and restore preflight using `@nerima-games/mc-kernel` 0.9 contracts
- Java modified UTF-8, NBT, gzip/zlib/none/LZ4, Anvil regions, external `.mcc` chunks, and standard save paths
- Shared `WorldId`, coordinate brands, and save-slice contracts from `@nerima-games/mc-kernel`

Consumers keep player, chunk, and world schemas, settings policy, save timing, simulation state, and session lifecycle in their own packages.

## Setup

```console
nix develop
pnpm install --frozen-lockfile
```

Without Nix, use Node.js 24 or newer and pnpm 12.14.0. `package.json` defines the supported engines and package-manager version.

## Minimal API example

```typescript
import { Effect, Result, Schema } from 'effect'
import { defineFormat, InMemoryStorageLayer, SaveKey, saveTo } from '@nerima-games/mc-save'

const playerFormat = defineFormat({
  name: 'player',
  version: 1,
  schema: Schema.Struct({ health: Schema.Number }),
})

const savePlayer = Result.isSuccess(playerFormat)
  ? saveTo(playerFormat.success, SaveKey('player'), { health: 20 })
  : Effect.fail(playerFormat.failure)

await Effect.runPromise(savePlayer.pipe(Effect.provide(InMemoryStorageLayer)))
```

`defineFormat` returns a `Result`; handle invalid definitions before using the format. `saveTo` encodes the value, seals and validates the envelope, then writes it. `decodeSave` accepts only the exact format name and version and does not migrate older payloads.

## Repository structure

```text
src/index.ts                         public entry point
src/application/                     generic revision writes and write queue
src/domain/format*.ts                format definition and codecs
src/domain/envelope.ts               envelope structure
src/domain/integrity*.ts             canonical bytes, checksum, and size checks
src/domain/persistence.ts            codecs joined to StoragePort
src/domain/storage-port.ts           storage service and in-memory adapter
src/domain/indexeddb-*.ts             IndexedDB layout, runtime, and adapter
src/domain/save-slices.ts             save-slice bundles and migration preflight
src/domain/minecraft-*.ts             Minecraft Java codecs and standard paths
test/                                Node, fake IndexedDB, and Chromium checks
docs/                                API, ownership, migration, and test guides
```

## Verification

```console
pnpm verify
pnpm test:coverage
pnpm test:browser
pnpm package:verify
pnpm audit
```

`pnpm verify` runs type checks, lint, and Node tests. Coverage requires 100% for branches, functions, lines, and statements. Browser tests use Chromium's real IndexedDB. Package verification packs the library and checks it from a clean consumer.

## Compatibility boundaries

- Persisted envelopes contain the format name, version, payload, and integrity metadata.
- `encodeSave` returns an unsealed draft; persistence operations store a sealed envelope.
- Stored values are revalidated at read boundaries.
- Older product-specific payloads require an explicit consumer migration. The save-slice API validates and migrates registered slices before calling restore callbacks.
- Minecraft NBT and Anvil codecs preserve supported wire data; consumers define game-specific schema meaning.
- IndexedDB layout versions are independent of save format versions.

See [the 0.6.0 migration guide](docs/migration.md), [public API reference](docs/public-api.md), and [verification guide](docs/testing.md).

## License

MIT
