# mc-save ドキュメント

`@nerima-games/mc-save` を実装するために必要な情報をここに集約している。
**plan.md を読み直さなくても実装できる**ことを目標に書いてある。

## 表記

| 表記 | 意味 |
| --- | --- |
| `<reference-impl>` | **参照実装のチェックアウトのルート**。凍結された `takeokunn/ts-minecraft` の作業コピーを指す。本ドキュメント群では `<reference-impl>/packages/…` の形か、単に `packages/…`（同じくルート相対）で引用する。手元のどこに clone してあっても読み替えられるようにするためのプレースホルダである |
| plan.md | リポジトリ構成仕様書（16 リポジトリ、確定済み）。**非公開**であり、公開読者は開けない。だから本ドキュメント群は「plan.md を読まなくても追える」ことを要件にしている —— plan.md の主張を引くときは必ず原文を引用し、参照実装での裏づけを file:line で添える |
| `nerima-games/<repo>` | 同 org の兄弟リポジトリ。リンクは GitHub の URL で張る |

## 読む順序

| ファイル | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | 4 階層アーキテクチャ、16 リポジトリ依存グラフ、mc-save の位置 |
| [responsibility.md](./responsibility.md) | 責務と**非スコープ**、親・子リポジトリ |
| [public-api.md](./public-api.md) | 公開すべき API。参照実装の実コードで検証済み |
| [design-notes.md](./design-notes.md) | 設計注意。参照実装の証拠 (file:line) 付き、回帰テスト名として提示 |
| [porting.md](./porting.md) | 移植元パスと**実測 LOC** |
| [testing.md](./testing.md) | 検証要件・完了条件・カバレッジゲートの扱い |
| [versioning.md](./versioning.md) | 0.x → 1.0.0 の方針、GitHub Packages、publish の開始時期 |

## 最初に知っておくべき 3 点

1. **マイグレーション機構は参照実装に存在しない。** mc-save の `defineFormat` は移植ではなく**新規**である。
   参照実装の互換性戦略は「新フィールドを `Schema.optional` にする」だけであり、
   リネーム・再構造化は一度も行われていない。詳細は [design-notes.md](./design-notes.md#dn-1)。

2. **plan.md §3.5 の「参照実装の save fixture を資産として移植」は実行できない。**
   参照実装に旧セーブの fixture ファイルは **1 個も存在しない**。
   詳細は [design-notes.md](./design-notes.md#dn-2)。

3. **plan.md §3.5 の「storage 3 ファイル 535 LOC」は数え方が混ざっている。**
   名指しされた 3 ファイルは **273 LOC**、535 は `packages/world/infrastructure/` **全 5 ファイル**の合計である。
   詳細は [porting.md](./porting.md#loc)。

## 現在の状態

叩き台 (pre-audit first cut)。`pnpm verify` は green。
ビルド／publish パイプラインは未整備で、完成条件到達時に追加する ([versioning.md](./versioning.md))。
