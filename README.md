# @nerima-games/mc-save

## 責務

永続化基盤。**バージョン付きコーデックツールキット + セーブフォーマットレジストリ + `StoragePort`**。

各ドメインのフォーマット自体は各リポジトリが本ツールキットで定義する。
mc-save は「何を保存するか」を知らない。

## 依存

`effect` と `@nerima-games/mc-kernel` のみ。
直接依存のホワイトリストは**空集合**であり、`pnpm check:deps` が機械的に強制している。

mc-save に依存するのは `mc-worldgen` と `mc-sim` の 2 つである。

## ドキュメント

実装に必要な情報は全て [`docs/`](./docs/) にある。**plan.md を読み直す必要は無い。**

| ファイル | 内容 |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | 4 階層、16 リポジトリ依存グラフ、mc-save の位置 |
| [docs/responsibility.md](./docs/responsibility.md) | 責務と非スコープ |
| [docs/public-api.md](./docs/public-api.md) | 公開 API（参照実装で検証済み） |
| [docs/design-notes.md](./docs/design-notes.md) | 設計注意 + 回帰テスト |
| [docs/porting.md](./docs/porting.md) | 移植元と実測 LOC |
| [docs/testing.md](./docs/testing.md) | 検証要件と完了条件 |
| [docs/versioning.md](./docs/versioning.md) | 0.x → 1.0.0、publish 方針 |

## plan.md からの補正（重要）

| plan.md §3.5 の記述 | 実測 |
| --- | --- |
| storage 3 ファイル **535 LOC** | 名指しの 3 ファイルは **273 LOC**。535 は `infrastructure/` 全 5 ファイルの合計 |
| 「参照実装の save fixture を資産として移植」 | **fixture は 1 個も存在しない。** 新規作成が必要 |
| DB 名は `'minecraft-worlds'` | **正しい**（`storage-idb-model.ts:8`） |

加えて、**マイグレーション機構は参照実装に存在しない**。
`defineFormat` は移植ではなく新規実装である。詳細は [docs/design-notes.md](./docs/design-notes.md)。

## 開発

### セットアップ

```console
$ direnv allow          # devenv 経由で nodejs_22 + pnpm が入る
$ pnpm install
```

devenv を使わない場合は Node.js 22 以上と pnpm 9.15.0（`corepack` 推奨）を用意する。

> **注意**: `devenv.lock` はコミットされていない。生成には `devenv` の実行が必要なため、
> 初回に devenv を動かした人がコミットすること。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json` と `tsconfig.test.json` の両方を型検査 |
| `pnpm lint` | oxlint（唯一の lint/format 設定） |
| `pnpm lint:fix` | oxlint の自動修正 |
| `pnpm test` | vitest（`@effect/vitest` の `it.effect`） |
| `pnpm test:watch` | vitest watch |
| `pnpm test:coverage` | カバレッジ計測（閾値は未設定。[docs/testing.md](./docs/testing.md) 参照） |
| `pnpm check:deps` | 依存ホワイトリスト + 循環検査 + `Date.now()` 禁止 |
| `pnpm verify` | `typecheck && lint && check:deps && test`。CI と同じ |

### 構成

```
index.ts                                公開バレル
domain/
  envelope.ts        バージョン付きエンベロープ
  errors.ts          StorageError / SaveDecodeError / MigrationError / DuplicateFormatError
  format.ts          defineFormat、マイグレーション連鎖、encode/decode
  persistence.ts     saveTo / loadFrom（コーデックと媒体が出会う唯一の場所）
  registry.ts        フォーマットレジストリ（immutable）
  storage-port.ts    StoragePort + インメモリ/失敗アダプタ
scripts/
  check-dependency-whitelist.ts   16 リポジトリ共通のゲート
test/                             47 tests
docs/                             実装情報
```

## 現状

**このリポジトリはまだ叩き台（pre-audit first cut）である。**

- **IndexedDB アダプタは未実装。** `lib: ["DOM"]` を足すとツールキットが platform-free で
  あることを型で証明できなくなるため、別 tsconfig で隔離してから追加する
- **旧セーブ fixture が無い。** 参照実装に移植元が存在しないため新規作成が必要
- **リトライ / クォータのポリシーは持たない。** エラー型だけ定義し、`Schedule` は利用側が巻く
- **ビルド／publish はまだない。** `exports` は TypeScript ソースを直接指している
- **カバレッジ閾値は未設定。** 99% ゲートは完成条件到達時に有効化する

## License

MIT
