# テストと完了条件

## 1. コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json`（出荷ソース）と `tsconfig.test.json`（テスト+ツール）の両方 |
| `pnpm lint` | oxlint。このリポジトリ唯一の lint/format 設定（prettier も biome も .editorconfig も置かない） |
| `pnpm check:deps` | 依存ホワイトリスト + 循環検査 + `Date.now()` 禁止 |
| `pnpm test` | vitest（`@effect/vitest` の `it.effect` が主 API） |
| `pnpm test:coverage` | カバレッジ計測。**閾値は未設定**（後述） |
| `pnpm verify` | 上記 4 つ（coverage 以外）。CI と同一内容 |

`pnpm` は PATH に無い場合がある。`corepack pnpm <cmd>` で 9.15.0 が起動する。

## 2. 現状のテスト

```
test/format-roundtrip.test.ts    12 tests   コーデックのラウンドトリップ、連鎖検証
test/migration.test.ts            8 tests   マイグレーション（リネームを含む）、Port 経由のロード
test/storage-port.test.ts         8 tests   StoragePort の契約テスト
test/dependency-policy.test.ts   19 tests   16 リポジトリのグラフ、import ゲート、時計禁止
                                 ─────
                                 47 tests   全て green
```

### 契約テストという書き方

`test/storage-port.test.ts` の assertion は全て `StoragePort` **インターフェースに対して**書いてある。
実装（インメモリ）に対してではない。
IndexedDB アダプタが来たら、Layer を差し替えるだけで同じブロックを再実行できる。

参照実装はこれをやっていなかった。5 つの手書き二重化があり
（[public-api.md](./public-api.md) §5）、どれも実アダプタと突き合わせられていなかった。
実ブラウザでの契約テストは `e2e/contracts/storage-service-contract-runner.ts` に
36 LOC だけ存在したが、ユニットテスト側の二重化とは別物だった。

## 3. plan.md §3.5 が要求する検証

> **検証**: ラウンドトリップテスト + マイグレーションテスト +
> **旧セーブ fixture との互換テスト**（参照実装の fixture を資産として移植）

| 要求 | 状態 |
| --- | --- |
| ラウンドトリップテスト | ✅ `test/format-roundtrip.test.ts` |
| マイグレーションテスト | ✅ `test/migration.test.ts` |
| 旧セーブ fixture との互換テスト | ⬜ **fixture が参照実装に存在しない**（[design-notes.md](./design-notes.md#dn-2)）。新規作成が必要 |

## 4. 完了条件

このリポジトリが「完成」と言えるのは以下が全て満たされたときである。

1. `pnpm verify` が green
2. **バージョンごとのゴールデン fixture が commit されている**
   - fixture を**書き出す仕組み**も同時にある（手書き JSON は禁止。
     「現行コードが出力するもの」ではなく「人が出力すると思ったもの」を固定してしまう）
   - フォーマットが持ったことのある全バージョンに fixture がある
3. **IndexedDB アダプタが実装され、契約テストが実ブラウザで green**
   - `test/storage-port.test.ts` を実アダプタに対して再実行できる
4. **mc-worldgen が実際に `defineFormat` でチャンクフォーマットを定義し、消費している**
   - ツールキットは消費者なしには正しさを主張できない
5. カバレッジ 99% ゲートが有効化されている（後述）

プレビューは無い。UI を持たないリポジトリだからである
（plan.md §2.3-4 の「プレビューは検証対象と同居する」の対象外）。

## 5. カバレッジ閾値: 今はまだ設定しない

参照実装は branches / functions / lines / statements の 99% を強制している。
mc-save でも**最終的には同じ 99% を課す**が、今は課さない。

理由: スケルトンに閾値を課しても意味が無い。
型定義だけのモジュールをいくつか置けば簡単に満たせてしまい、
実装の品質について何も語らない数字になる。

現状:

- 計測とレポートは**常に動いている**（`pnpm test:coverage`、CI でも実行してアーティファクト化）
- 閾値だけが未設定。`vitest.config.ts` の `coverage.thresholds` がコメントアウトされている
- CI の `Coverage` ステップも同様

**有効化のタイミング**: 上記「完了条件」の 1〜4 を満たした時点で、
`vitest.config.ts` と `.github/workflows/ci.yaml` の**両方**を同時に更新する。

```typescript
thresholds: { branches: 99, functions: 99, lines: 99, statements: 99 },
```

## 6. テストの書き方の規約

### `@effect/vitest` の `it.effect` を使う

```typescript
it.effect('name', () => Effect.gen(function* () { ... }).pipe(Effect.provide(SomeLayer)))
```

副作用の無い純粋な assertion には `Effect.sync(() => { ... })` を使う
（`Effect.gen` で `yield*` しないと oxlint の `require-yield` が警告する）。

### 例外: DOM イベントフローのテスト

plan.md §3.13 が記録している既知の落とし穴:

> DOM イベントフローのテストで `Effect.fork` + `Deferred.await` を `it.effect` で書くとデッドロックする
> — プレーン `it` + `Effect.runPromise` を使う

mc-save は DOM を持たないので現状は無関係だが、
IndexedDB アダプタのテストで発生しうる。頭の隅に置いておくこと。

### 回帰テストには「なぜ」を書く

参照実装のバグを固定するテストには、
**どのファイルの何行目の挙動を固定しているのか**をコメントに残すこと。
根拠を失ったテストは、次のリファクタで「よく分からないので消す」対象になる。

このリポジトリの既存テストは全てこの形式で書かれている。
