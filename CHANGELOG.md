# @nerima-games/mc-save

## 0.4.2

### Patch Changes

- [#24](https://github.com/nerima-games/mc-save/pull/24) [`4894155`](https://github.com/nerima-games/mc-save/commit/4894155fb09f83b54174533f88c9bb7271a81558) Thanks [@takeokunn](https://github.com/takeokunn)! - Add `test/migration.test.ts`, the evidence file the feature catalog's `save/versioned-persistence` row declared but the package never had. It documents, against a hand-authored v1 fixture (not produced by any encoder in this package), that `decodeSave` has no automatic upgrade path — it unconditionally refuses any envelope whose version does not match the format's current version — and demonstrates the migration path a consumer has to build for itself from `SaveEnvelopeSchema`, `Schema.decodeUnknown` against an old-version schema, and `encodeSave` under the current format. No source behavior changed.

## 0.4.1

### Patch Changes

- [#22](https://github.com/nerima-games/mc-save/pull/22) [`38f1f9e`](https://github.com/nerima-games/mc-save/commit/38f1f9ef96917b5b65498b00386d19ac1d77ae44) Thanks [@takeokunn](https://github.com/takeokunn)! - Pin `@nerima-games/mc-kernel` to `0.7.0` (from `0.4.0`), matching the org's exact-pin policy. The coordinate and identifier primitives this package consumes (`WorldId`, `ChunkAxis`, `ChunkCoord`, `chunkCoord`, `CHUNK_SIZE_XZ`) are unchanged in behavior across the four kernel releases in between; no save-format bytes or checksum inputs are affected.

## 0.4.0

### Minor Changes

- [#20](https://github.com/nerima-games/mc-save/pull/20) [`eefd941`](https://github.com/nerima-games/mc-save/commit/eefd94198691f62a7737e19282af2f615216052b) Thanks [@takeokunn](https://github.com/takeokunn)! - Add `undefinedFieldsAsNull`, `restoreNullAsUndefined`, and `encodeUndefinedAsNull` — a reusable
  per-field `undefined` \<-\> `null` codec for `Schema.transform`-based formats. Multiple consumers
  have hand-rolled this pattern to satisfy the integrity checksum's rejection of a bare `undefined`
  anywhere in an encoded payload; this lowers the narrow, per-field swap into the format layer that
  requires it.

### Patch Changes

- [#19](https://github.com/nerima-games/mc-save/pull/19) [`efc2c38`](https://github.com/nerima-games/mc-save/commit/efc2c38c62050bb5388676bd8f7f759d8197f22e) Thanks [@takeokunn](https://github.com/takeokunn)! - Complete the org toolchain devDependency pin set: knip 6.33.0 (its verify gate arrives in Wave 3; the pin belongs to the Wave 0 table) plus @effect/vitest 0.30.0 where it was missing.

## 0.3.0

### Minor Changes

- [#8](https://github.com/nerima-games/mc-save/pull/8) [`bee1a52`](https://github.com/nerima-games/mc-save/commit/bee1a522c38e2e00cec78d43ef38d9b3be003174) Thanks [@takeokunn](https://github.com/takeokunn)! - Integrate durable save work and org-standard migration rescued from the unpushed local main (Phase 0 inventory 2026-08-08).

### Patch Changes

- [#17](https://github.com/nerima-games/mc-save/pull/17) [`4635acc`](https://github.com/nerima-games/mc-save/commit/4635accd26461798f167698b49a6551a6a22a023) Thanks [@takeokunn](https://github.com/takeokunn)! - Toolchain frozen to org pin set (TypeScript 7.0.2, vitest 4.1.11, effect 3.22.1, node 24, pnpm 11.24.0); build switched to tsc emit; release workflow added
