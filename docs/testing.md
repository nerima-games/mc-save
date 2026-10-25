# Verification

## Standard gates

Run the repository checks and retain the command results and selected test counts as evidence:

```text
pnpm typecheck       TypeScript checks for production and test code
pnpm lint            oxlint and ast-grep rules
pnpm test             Node unit and contract tests
pnpm test:coverage    coverage with 100% branch, function, line, and statement thresholds
pnpm typecheck:browser TypeScript check for browser tests
pnpm test:browser     Chromium IndexedDB contract tests
pnpm build            release JavaScript and declaration output
pnpm package:verify   packed files, exports, and a clean temporary consumer
pnpm audit            dependency audit
pnpm verify           typecheck, lint, and Node tests
```

Coverage, browser, package-boundary, and audit checks run separately from `verify`. A command that is interrupted is not a pass; check its exit status and runner assertions.

`pnpm check:source-policy` runs the raw wall-clock-read check directly. The same policy is part of `pnpm lint` through `.ast-grep/rules/no-wall-clock-read.yml`.

The `.ast-grep/rules/no-type-assertion.yml` rule rejects `as` (except `as const`) and non-null assertions in `src/` and `test/`. Use `Result` and typed error paths when a value cannot be proven to exist. `assertDefined` returns a `Result` for code paths where TypeScript cannot follow an established bounds or match check.

## Test layers

- Pure codecs: envelopes, integrity, binary, NBT, UTF-8, compression, and LZ4
- Java containers: Anvil regions, sector allocation, external `.mcc` chunks, and paths
- Persistence: strict formats, revalidation, corrupt-list separation, batch atomicity, durable rollback, and revision writes
- Save-slice contracts: migration paths, registration coverage, schema preflight, and restore behavior
- Adapters: in-memory storage, fake IndexedDB, and Chromium IndexedDB
- Public boundary: exported names, release build, and a packed tarball in a temporary consumer
- Source policy: production import boundaries and separation from Node-only APIs

The shared `StoragePort` contract runs against each adapter. Fake IndexedDB covers fast failure cases; Chromium exercises real browser IndexedDB transactions.

## Coverage thresholds

Branches, functions, lines, and statements must each reach 100%. Type-only declarations such as the browser surface are excluded from runtime coverage; exclusions are kept in the coverage configuration.

Do not pin a changing coverage percentage in this document. Use the current `pnpm test:coverage` output. New branches need tests for successful inputs, rejection cases, boundary values, and external-input failures.

## Integration scope

This repository verifies save contracts and Minecraft Java wire and container boundaries. Consumer repositories own game-specific player and chunk schemas, whole-game tick behavior, and end-to-end tests that start a vanilla world. Codec support does not imply that mc-save interprets every game-semantic payload.
