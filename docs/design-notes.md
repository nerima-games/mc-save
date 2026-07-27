# 設計注意

plan.md §3.5 の 設計注意 を、参照実装の実コード (file:line) で裏取りして展開したもの。
plan.md §6 Step 2 の方針に従い、**各項目を「書くべき回帰テストの名前」として提示する**。

`✅` = このスケルトンに実装済み / `⬜` = 未実装（実装時に必ず入れる）

---

<a id="dn-1"></a>
## DN-1 ✅ フォーマット変更は必ずマイグレーション付き

> plan.md §3.5:「フォーマット変更は必ずマイグレーション付き」

### 参照実装の実態: マイグレーション機構は**存在しない**

`packages/`、`src/`、`e2e/` を `MigrationManager|MigrationError` で grep した結果は **0 件**。
設計文書 `docs/reference/game-systems/save-file-format.md:644-690` に
`migrate: (data, fromVersion, toVersion)` の構想があるが、実装されていない。

実際の互換性戦略は **`Schema.optional` を付けるだけ**で、ソース中に明言がある:

- `packages/world/domain/world-metadata-model.ts:76`
  「Home dimension of the entity (absent in pre-dimension saves → overworld)」
- 同 `:114-117`「Plain optional so pre-vehicle saves decode to undefined」
- 同 `:126-127`「pre-feature saves decode without them and start from zero」
- `packages/core/domain/inventory-save-data.ts:15`
  「Anvil rename — optional keeps pre-rename saves decodable」

この手法は**一方向**である。フィールドの追加はできるが、
リネーム・再構造化・意味の変更はできない。

### 本当に変更が必要になったとき何が起きたか

`packages/world/application/chunk-manager-ops-storage.ts:54-60`:

```
// Repair chunks saved before the carver fix (hollow river/lake beds) BEFORE computing light
healHollowWaterBeds(...)
```

これはマイグレーションである。ただし**名前が無く、バージョン番号が無く、
テストが無く、いつ削除してよいか判断する手段が無い**マイグレーションである。

同ファイル `:47-50` にはもう 1 つある。バッファ長が違えばセーブを捨てて再生成する:

```
Effect.logWarning(`Chunk (...) has invalid buffer length ... regenerating`)
return Option.none()
```

`packages/world/application/chunk-manager-cache.ts:10-11` の `storedFluidBuffer` も同種で、
`fluid` が無いか長さが違えばゼロ埋めバッファを黙って差し込む。

### 書くべき回帰テスト

| テスト名 | 主張 |
| --- | --- |
| ✅ `defineFormat throws at definition time when the chain has a hole` | v3 なのに 1→2 が無ければ**定義時**に落ちる |
| ✅ `validateMigrationChain rejects a hole, naming the version whose saves would become unreadable` | どのバージョンのセーブが読めなくなるかをメッセージに含む |
| ✅ `validateMigrationChain rejects two migrations starting at the same version` | 連鎖は線形 |
| ✅ `migrateToCurrent runs every step from the envelope version up to the current one` | v1 のセーブが v3 まで上がる |
| ✅ `migrateToCurrent starts partway through the chain` | v2 のセーブは 2→3 だけ走る |
| ✅ `loadFrom migrates a v1 envelope written by an old build all the way to v3` | Port 経由の実地確認 |
| ✅ `migrateToCurrent labels a failing step with the format and the exact version pair` | エラーが `describe` を含む |

実装は `test/format-roundtrip.test.ts` / `test/migration.test.ts`。
`test/migration.test.ts` の v1→v2 は**フィールドのリネーム**を扱っており、
これは参照実装の戦略では表現できなかった変更である。

---

<a id="dn-2"></a>
## DN-2 ⬜ 旧セーブ fixture は参照実装に存在しない

> plan.md §3.5 検証:「**旧セーブ fixture との互換テスト**（参照実装の fixture を資産として移植）」

### この指示は実行できない

参照実装に旧セーブを表す fixture ファイルは **1 個も無い**。

- `e2e/fixtures/` の中身は `game-page.ts`（Playwright の page object）**のみ**
- `packages/`、`test/`、`e2e/` のどこにもセーブデータの `.json` / `.bin` / `.dat` は無い

「旧セーブ」のシナリオは全てテスト内のオブジェクトリテラルで、
フィールドを省いて構成していた
（例: `packages/world/test/storage-service-schema.test.ts:239`
`'requires current playerState fields'`）。

### したがって mc-save 側で新規に作る

これは移植ではなく**穴埋め**である。バージョンごとにゴールデンファイルを置く:

```
test/fixtures/
  player-state.v1.json
  player-state.v2.json
  chunk.v1.json
```

### 書くべき回帰テスト

| テスト名 | 主張 |
| --- | --- |
| ⬜ `every golden fixture on disk decodes to the current version` | fixture ディレクトリを走査し、全件が現行版まで上がる |
| ⬜ `a fixture is committed for every version this format has ever had` | fixture の欠落自体を fail にする |

**fixture を書き出す仕組みも同時に作ること。** 手で JSON を書くと、
「現行コードが出力するもの」ではなく「人が出力すると思ったもの」を固定してしまう。

---

<a id="dn-3"></a>
## DN-3 ⬜ 「破損」と「未来のセーブ」を混同しない

plan.md には無いが、参照実装の実測から出てきた項目である。

### 参照実装の挙動

一括読み込みは `{ valid, corrupt }` に分割するが、判定基準は
**`Schema` が受理したかどうか**だけである
（`packages/world/infrastructure/storage-serialization.ts:43-49`）。

UI 側はそれを直訳して、`corrupt` の要素に削除ボタンだけを出す
（`packages/presentation/menu/main-menu-handlers.ts:137-142`）:

```
`${String(worldId)} (corrupt)`
```

`saveVersion` は書かれていたが分岐に使われていなかった（[public-api.md](./public-api.md) §2）ため、
**古いビルドを起動したプレイヤーは、健全なワールドを削除するよう勧められた**ことになる。

なお単発ロードと一括読み込みで挙動が違う点にも注意:
単発は `storage-serialization.ts:11-14` で `ParseError` → `StorageError` に変換して**即座に失敗**する。

### 書くべき回帰テスト

| テスト名 | 主張 |
| --- | --- |
| ✅ `reports a save written by a newer build as such, not as corruption` | `version > current` は専用メッセージ。「削除を提案してはならない」を明記 |
| ✅ `reports the recorded version when the payload does not satisfy the schema` | エラーがエンベロープの記録バージョンを保持する |
| ✅ `refuses an envelope belonging to a different format, even when the payload would fit` | 鍵衝突が成功として通らない |
| ⬜ `a corrupt record does not take the whole listing down` | 一括読み込みの `{ valid, corrupt }` 分割（未実装） |

---

<a id="dn-4"></a>
## DN-4 ✅ DB 名は `'minecraft-worlds'`

> plan.md §3.5:「参照実装の DB 名は `'minecraft-worlds'`（`'ts-minecraft'` ではない — 互換を取るなら注意）」

**この記述は正しい。** 裏取り済み:

```
packages/world/infrastructure/storage-idb-model.ts:8
export const DB_NAME = 'minecraft-worlds'
```

同ファイルの周辺定数もそのまま使う:

```
:7  export const WORLD_SCHEMA_VERSION = 3
:9  export const DB_VERSION = 2
:10 export const STORE_CHUNKS = 'chunks'
:11 export const STORE_METADATA = 'metadata'
```

設定は**別 DB** である: `'minecraft-settings'` v1 / ストア `'settings'` / 鍵 `'current'`
（`packages/game/infrastructure/settings-storage-service.ts:5-8`）。

### 書くべき回帰テスト

| テスト名 | 主張 |
| --- | --- |
| ✅ `creates a database under the name it was given, and no other` | **定数の持ち主が変わった形で移植済み**（`test/indexeddb-storage.test.ts`）。`'minecraft-worlds'` はゲーム側の定数であり、mc-save が知ってよいものではない — 鍵 `worldId:x:z` を知らないのと同じ理由。mc-save が主張できるのは「渡された名前をそのまま使う」ことで、間違えたら全プレイヤーのワールドが消えたように見えるのは同じである |

---

<a id="dn-5"></a>
## DN-5 ✅ ストレージ層は時計を読まない

参照実装のストレージ層を `Date.now()` / `new Date(` / `performance.now()` で grep した結果は **0 件**。
タイムスタンプは呼び出し側が `Clock.currentTimeMillis` から取って渡していた
（`packages/app/application/main/session-persist.ts:54`, `:82`）。

これは偶然ではなく、決定論とリプレイのために必要な性質である。

### 書くべき回帰テスト

| テスト名 | 主張 |
| --- | --- |
| ✅ `flags Date.now(), new Date() and performance.now()` | ゲート自体が動く |
| ✅ `ignores a clock read that only appears inside a comment or a string` | 誤検知しない |
| ✅ `exempts a line carrying the escape-hatch marker` | Clock Port の実装アダプタだけが逃げられる |

実装は `test/dependency-policy.test.ts`。
機械的な強制は `pnpm check:deps`（`scripts/check-dependency-whitelist.ts`）が行う。
oxlint 0.12 は `no-restricted-syntax` も `no-restricted-properties` も実装しておらず、
`no-restricted-globals` も一覧に出るだけで動かない（0.12.0 で実測確認済み）。

---

<a id="dn-6"></a>
## DN-6 ⬜ チャンクは型付き配列のまま格納されている

参照実装のチャンク永続化は encode/decode ステップを**持たない**。

- レイアウト（`packages/world/domain/chunk.ts:11-12`）:
  `index = y + (z * CHUNK_HEIGHT) + (x * CHUNK_HEIGHT * CHUNK_SIZE)`、
  16×16×256 = 65,536 バイト
- 流体バッファも同形・同サイズ（`packages/block/domain/fluid.ts:7` `FLUID_BYTE_LENGTH`）
- 書き込みは `db.put(STORE_CHUNKS, data, chunkKey(...))`（`storage-service.ts:101-106`）
- **skyLight / blockLight は永続化されず、ロード時に再計算される**
  （`chunk-manager-ops-storage.ts:61` の `ctx.lightEngine.updateLight(baseChunk)`）

つまり 1 チャンクあたり 64KB（ブロック）+ 64KB（流体）が無圧縮・無タグで入る。

### 実装時の注意

- structured clone は `Uint8Array` をそのまま通すので、
  エンベロープの `payload` に `Uint8Array` を入れる設計は IndexedDB では成立する。
  ただし JSON 化する経路（エクスポート、ネットワーク）では成立しない。
  **どちらを正とするかを decide してから schema を書くこと。**
- 圧縮は計測してから入れる。参照実装は無圧縮で運用できていた。

### 書くべき回帰テスト

| テスト名 | 主張 |
| --- | --- |
| ⬜ `a chunk payload survives a structured-clone round trip byte-for-byte` | 型付き配列が壊れない |
| ⬜ `a chunk saved with the wrong buffer length is rejected with its recorded version, not silently regenerated` | 参照実装の `:47-50` の挙動を改善したことを固定する |

---

## DN-7 ⬜ リトライ / クォータのポリシーは Port の上に置く

参照実装のポリシー（`packages/world/infrastructure/storage-error-mapping.ts:12-19`）:

- 3 回リトライ、`Schedule.exponential(100ms)`
- `QuotaExceededError`（`DOMException.name` で判定、`:4-5`）なら中断
- **`saveChunk` / `loadChunk` / `save|loadWorldMetadata` にのみ適用**。
  `deleteWorld` と `listWorldMetadata` には付いていない（一貫していない）

mc-save は `StorageError` を定義するだけで、`Schedule` は巻かない。
巻く場所を決めるのは最初の実消費者（mc-worldgen）である。

| テスト名 | 主張 |
| --- | --- |
| ✅ `failingStorageLayer fails writes with a StorageError naming the operation and key` | ポリシーを上に載せてテストできる土台がある |
| ⬜ `the retry policy applies uniformly to every StoragePort method` | 参照実装の不統一を繰り返さない |
