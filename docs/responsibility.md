# 責務

出典: plan.md §3.5。参照実装の実コードで補正した箇所には根拠を付けてある。

## 1. 責務（plan.md §3.5 原文）

> **永続化基盤** = バージョン付きコーデックツールキット + IndexedDB アダプタ + セーブフォーマットレジストリ。
> **各ドメインのフォーマット自体は各リポジトリが本ツールキットで定義する。**

最後の一文が最も重要である。mc-save は「何を保存するか」を知らない。

### 具体的に持つもの

| 要素 | 説明 |
| --- | --- |
| バージョン付きコーデック | `defineFormat(name, version, schema, migrations)` |
| マイグレーション連鎖 | v1→v2→…→vN を 1 段ずつ。連鎖の穴は**定義時**に例外 |
| セーブエンベロープ | `{ format, version, payload }`。バージョンが payload の**外側**にある |
| `StoragePort` | 鍵とエンベロープしか知らない狭い Port |
| インメモリアダプタ | Port の**正典実装**。テスト用ではなく契約の基準 |
| フォーマットレジストリ | 登録済みフォーマットの列挙。immutable な値 |
| IndexedDB アダプタ | **実装済み**。`src/domain/indexeddb-storage.ts`。ストア 1 本（`saves`）と挿入順インデックス 1 本を自前で持つ。[public-api.md](./public-api.md#idb) 参照 |

## 2. 非スコープ（ここに書いたら負け）

| 非スコープ | 正しい置き場 | 理由 |
| --- | --- | --- |
| チャンクのフォーマット定義 | **mc-worldgen** | チャンクが何かを知るのは worldgen。mc-save は `defineFormat` を貸すだけ |
| プレイヤー状態・インベントリのフォーマット定義 | **mc-sim** | 同上 |
| 設定のフォーマット定義 | 設定を所有するリポジトリ | 同上 |
| **いつ保存するか**（自動保存のスケジュール） | **mc-sim**（`forkDaemon` + `Schedule.spaced`） | plan.md §3.8。mc-save は呼ばれる側 |
| セッション編成（どのワールドを開くか） | **mc-compose** | plan.md §7 の対応表どおり |
| ワールド選択・作成の画面 | **mx-ui** | DOM は mx-ui の専管 |
| リトライ / クォータ超過のポリシー | **アダプタを注入する側** | エラー型は mc-save が定義するが、`Schedule.exponential` を巻くのは利用側 |
| タイムスタンプの取得 | **呼び出し側**（Clock Port 経由） | 参照実装のストレージ層も clock を一切読んでいない（§3 参照） |

### 特に注意: 「保存の意思決定」は持たない

参照実装では自動保存が `packages/app/application/main/session-autosave.ts` (67 LOC) にあり、
ストレージ層とは分離されていた。この分離は正しく、維持する。
mc-save に「30 秒ごとに保存」を書いた時点で、テストが時計に依存し始める。

## 3. 参照実装から引き継ぐ良い性質

### 3-1. ストレージ層は時計を読まない（実測確認済み）

`packages/world/infrastructure/`、`packages/world/domain/storage-*.ts`、
`packages/game/infrastructure/settings-storage-service.ts` を
`Date.now()` / `new Date(` / `performance.now()` で grep した結果は **0 件**である。

タイムスタンプは呼び出し側が渡していた:

- `packages/app/application/main/session-persist.ts:54` — `const nowMs = yield* Clock.currentTimeMillis`
- `packages/app/application/main/session-persist.ts:82` — `lastPlayed: new Date(nowMs)`

この性質は mc-save でも維持する。raw clock read の自動強制は現時点で無い
（[design-notes.md DN-5](./design-notes.md#dn-5) 参照）。

### 3-2. アプリケーション向けの Port は狭かった

フルサービスは 7 メソッドあったが、アプリ層に露出していた
`StorageServicePort`（`packages/world/domain/storage-service-port.ts:14-31`）は
`saveChunk` / `loadChunk` の **2 メソッドだけ**だった。この禁欲は正しい。

mc-save の `StoragePort` は 4 メソッド（`get` / `put` / `remove` / `keys`）で、
しかもドメイン語彙（chunk / metadata）を一切含まない。

### 3-3. 一括読み込みは壊れたレコードを隔離していた

`packages/world/infrastructure/storage-serialization.ts:43-49` は
`{ valid, corrupt }` に分割して返しており、1 件の破損で全ワールド一覧が死なないようになっていた。
この分割は維持する価値がある。

ただし「壊れている」の判定基準には問題があった → [design-notes.md](./design-notes.md#dn-3)。

## 4. 親・子

### 親（mc-save が依存してよいリポジトリ）

| リポジトリ | 何のために |
| --- | --- |
| `mc-kernel` | `WorldId` 等のブランデッド型、Clock Port の型。**唯一の依存**（普遍的に import 可、ホワイトリスト記載不要） |

直接依存の許可リストは**空集合**である
（[DEPENDENCY_POLICY.md](https://github.com/nerima-games/.github/blob/main/DEPENDENCY_POLICY.md) §1、
実効機構は `.oxlintrc.json` の `no-restricted-imports`）。

### 子（mc-save に依存するリポジトリ）

| リポジトリ | mc-save をどう使うか |
| --- | --- |
| `mc-worldgen` | チャンクフォーマットを `defineFormat` で定義し、`StoragePort` に書く |
| `mc-sim` | プレイヤー状態・インベントリ・統計のフォーマットを定義する |

mc-compose は mc-save に**直接は依存しない**（推移閉包の禁止）。
セッション編成は mx-* 経由で行う。

## 5. スケルトン段階で意図的に省いたもの

| 省略したもの | 理由 | いつ入れるか |
| --- | --- | --- |
| ~~IndexedDB アダプタ~~ | ~~`lib: ["DOM"]` が必要になる~~ → **前提が誤りだった。** 狭い構造型 + 部分集合証明で `lib` を広げずに実装できた（`src/domain/indexeddb-surface.ts`） | **済**（別 tsconfig も不要だった） |
| リトライ / クォータポリシー | 誰が巻くべきかがまだ決まっていない | 最初の実消費者（worldgen）が決める |
| 圧縮 | 参照実装は無圧縮（1 チャンク 64KB + 流体 64KB）。計測なしに入れない | 実測後 |
| `@nerima-games/mc-kernel` への依存 | 未 publish（plan.md §6 Step 0） | kernel が消費可能になった時点 |
