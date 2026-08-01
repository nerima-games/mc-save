# バージョニングと公開

## 1. 現在: `0.1.0`、未公開

`package.json`:

```json
"version": "0.1.0",
"publishConfig": { "registry": "https://npm.pkg.github.com", "access": "restricted" }
```

`publishConfig` は書いてあるが、**publish はまだ一度も行っていない**。

## 2. なぜまだ公開しないのか

plan.md §6 Step 0 / §8:

> npm 公開・バージョン bump 運用は**界面が十分安定するまで開始しない**
>
> リスク「新規構築初期は全界面が高 churn」→ 対策「npm 公開を遅らせ dev-meta workspace で開発。
> bump 連鎖を構造的に回避」

「界面の安定」は日数計測ベースの自動ゲートでは判定しない。旧・`api-lock.md` の
「4 週間無変更で凍結」という freeze-clock 機構は org 標準として廃止されている
（[API_STANDARD.md §4](https://github.com/nerima-games/.github/blob/main/API_STANDARD.md)）。
代わりに、1.0.0 への昇格と同様、**maintainer の裁量判断**による
（[RELEASE_STANDARD.md §4.2](https://github.com/nerima-games/.github/blob/main/RELEASE_STANDARD.md#42-新しい昇格ポリシー人間による裁量判断)）。

16 リポジトリが互いに依存している状態で早期に publish を始めると、
kernel の些細な変更が 15 リポジトリの version bump を誘発する。
開発初期は界面が動くのが当たり前なので、これは毎日起きる。

代わりに `mc-dev-meta` workspace で `workspace:*` 解決を使い、
モノレポと同等の DX で開発する。

### 現時点で `dependencies` に `effect` しか無い理由

スケルトン段階では**兄弟リポジトリへの依存を意図的に持たない**。

- 何も publish されていないので、`@nerima-games/mc-kernel` は解決できない
- スケルトンには import すべき兄弟のコードがまだ無い

意図された依存グラフは**コードとドキュメントの側に**記録してある:

- `oxlint.json` の `no-restricted-imports`（mc-save 自身の許可先を機械的に強制する）
- [DEPENDENCY_POLICY.md](https://github.com/nerima-games/.github/blob/main/DEPENDENCY_POLICY.md) §1（org 全体の許可グラフの正典）
- [architecture.md](./architecture.md) の Mermaid 図

publish 開始時に、ボトムアップ（kernel → 各 tier1 → worldgen → …）で
**publish してから pin する**。

## 3. `0.x` の間の約束

| 項目 | 方針 |
| --- | --- |
| semver | `0.x` なので minor bump で破壊的変更が入りうる |
| 破壊的変更の扱い | CHANGELOG に必ず書く。黙って変えない |
| 消費者 | まだ居ない。居ないうちに界面を固める |

## 4. `1.0.0` にする条件

**下流リポジトリが実際に消費して契約を確認したとき**に、maintainer の裁量判断で `1.0.0` にする
（[RELEASE_STANDARD.md §4.2](https://github.com/nerima-games/.github/blob/main/RELEASE_STANDARD.md#42-新しい昇格ポリシー人間による裁量判断)。
「〇〇日間 API 変更なし」のような日数計測ベースの自動ゲートは設けない）。

mc-save の場合、判断材料になる具体的な事実は:

1. `mc-worldgen` が `defineFormat` でチャンクフォーマットを定義している
2. `mc-sim` が同じくプレイヤー状態のフォーマットを定義している
3. IndexedDB アダプタが実装済みで、契約テストが実ブラウザで green
   （**アダプタは済**: `src/domain/indexeddb-storage.ts`。契約ブロックは
   `test/storage-port-contract.ts` としてインメモリと IndexedDB の両方に対して走っている。
   **残るのは「実ブラウザで」の部分だけ** — 現状は `test/fake-indexeddb.ts` に対して走る。
   fake が何を再現し何を再現しないかは同ファイル冒頭に列挙してある）

「良さそうだから 1.0 にする」はしない。
**実消費者が 2 つ付いて初めて、界面が正しいかどうかの証拠が揃う。**

## 5. ビルドと publish のパイプライン

### 現状: ビルドステップが無い

`package.json`:

```json
"main": "./src/index.ts",
"types": "./src/index.ts",
"exports": { ".": "./src/index.ts" }
```

**TypeScript ソースを直接指している。** `tsconfig.base.json` の `noEmit: true` も同じ理由である。

これは `mc-dev-meta` workspace 内でのみ成立する構成である
（consumer 側がソースをコンパイルする）。

### 完成時に追加するもの

1. `tsconfig.build.json` の `noEmit` を外し、`dist/` に emit する
2. `exports` を `dist/index.js` + `dist/index.d.ts` に向ける
3. `files` から `src` を外し `dist` を入れる
4. CI に `pnpm build` と、tag push での `pnpm publish` を追加
5. `.npmrc` に GitHub Packages の認証設定（`//npm.pkg.github.com/:_authToken=`）を追加

### `.npmrc` の現状

今入っているのは publish 設定ではなく、**依存解決の回避策**である:

```
public-hoist-pattern[]=fast-check
public-hoist-pattern[]=pure-rand
```

`fast-check` は `effect` の推移的依存（`effect/FastCheck` の re-export 経由）だが
pnpm が既定で hoist しないため、`tsc` が型を解決できない。
`pure-rand` は `fast-check` の実行時依存で、Vite が
フラットな `node_modules/fast-check` から解決できるように並べて hoist している。

## 6. セーブフォーマットのバージョンは別物

**混同しないこと。** このリポジトリには 2 種類のバージョンがある。

| | 何を表すか | どこにある |
| --- | --- | --- |
| パッケージバージョン | npm の `@nerima-games/mc-save` の版 | `package.json` の `version` |
| セーブフォーマットバージョン | 各フォーマットのスキーマ世代 | `defineFormat({ version })` |

パッケージを `0.1.0` → `0.2.0` に上げてもセーブフォーマットは変わらないし、
その逆もある。

セーブフォーマットのほうは**プレイヤーのディスク上のデータと直結している**ので、
遥かに厳格に扱う:

- 一度出荷したバージョンの番号は永久に欠番にしない
- そのバージョンから現行版までの経路（マイグレーション連鎖）を常に維持する
- 連鎖に穴を空けたら `defineFormat` が**定義時に throw** する

`describeRegistry` の出力を snapshot に取っておくと、
セーブフォーマットの変更が PR の diff に現れる。
plan.md §6 Step 0 が求める API ロックファイルの、セーブ版である。
