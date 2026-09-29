# @nerima-games/mc-save

## 0.5.0

### Minor Changes

- [#34](https://github.com/nerima-games/mc-save/pull/34) [`86c79c1`](https://github.com/nerima-games/mc-save/commit/86c79c1e2c8e7a1e2a4c0a5173e5509a80a02d44) Thanks [@takeokunn](https://github.com/takeokunn)! - tsconfig の strictness を mc-kernel と揃えました。`tsconfig.base.json` に `strictBuiltinIteratorReturn` と `isolatedDeclarations` を追加しています。

  `isolatedDeclarations` は export された宣言を他ファイルからの推論で書けないことを要求するため、公開 `.d.ts` の記述が書き換わります。error クラスは `Data.TaggedError('X')<{...}>` をそのまま `extends` できず、tag constructor を名前付き const に束縛して解決済みの shape を注釈する形になりました。`StoragePort` も同じ理由で `Context.TagClass` 経由の基底になります。mc-kernel の `ClockPort` と同じ形です。

  これは型注釈の付け替えであり、公開 API の意味論の変更ではありません。`_tag` literal、field 名・型・optionality、`message` getter、export 一覧はそのままです。生成される `.d.ts` と `.js` の差分は、class の基底が同じ constructor を指す名前付き const になったことだけです。dist を一時 consumer から import して、constructor の引数、`_tag`、`message`、Layer 注入、定数の型（`DEFAULT_NBT_CODEC_OPTIONS` は `maxBytes: number`、他 3 フィールドは literal 型を維持）が変わっていないことを確認しました。

  算術で定義された定数、parameter の default 引数、`fixedUint8Array` の `Schema.filter` 戻り値、`SaveKey` の `Brand.refined` constructor、`DEFAULT_NBT_CODEC_OPTIONS` にも注釈を足していますが、どれも生成される宣言は変更前と一致します。`pnpm verify`、`test:coverage`（4 指標 100%）、`test:browser`、`package:verify` 通過。

### Patch Changes

- [#34](https://github.com/nerima-games/mc-save/pull/34) [`86c79c1`](https://github.com/nerima-games/mc-save/commit/86c79c1e2c8e7a1e2a4c0a5173e5509a80a02d44) Thanks [@takeokunn](https://github.com/takeokunn)! - `docs/versioning.md` が release 工程を誤って説明していたので直しました。版上げ PR は人手が `pnpm changeset version` を実行して作るもので、`.github/workflows/release.yaml` が自動で出すものではありません。release.yaml がやるのは版上げ PR が `main` に merge された後の detect、publish、tag だけです。`CHANGELOG.md` は repository 内では更新されますが `package.json` の `files` に含まれないため配布物に同梱されません。

- [#35](https://github.com/nerima-games/mc-save/pull/35) [`350e66d`](https://github.com/nerima-games/mc-save/commit/350e66d672de3b16cf86ff04802919b526cbcf2b) Thanks [@takeokunn](https://github.com/takeokunn)! - 同期した `mc-kernel` 0.8.0 の consumer 契約を公開 API、versioning、責務境界のドキュメントに反映しました。mc-save が利用する既存の kernel 公開型に該当しない 0.8.0 の移行項目は適用せず、保存 format と wire value は変更していません。

- [#35](https://github.com/nerima-games/mc-save/pull/35) [`350e66d`](https://github.com/nerima-games/mc-save/commit/350e66d672de3b16cf86ff04802919b526cbcf2b) Thanks [@takeokunn](https://github.com/takeokunn)! - Pin `@nerima-games/mc-kernel` to 0.8.0 and add compile-time coverage for the kernel-branded values accepted by the save API.

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
