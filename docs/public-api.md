# 公開 API

plan.md §3.5 が要求する API を、**参照実装の実コードと突き合わせて**確定させたもの。
根拠パスは全て `ts-minecraft` リポジトリ内の実在するファイル・行である。

## 0. plan.md が要求している API

> **主要な公開 API**: `defineFormat(name, version, schema, migrations)`、
> `StoragePort`（IndexedDB 実装 + テスト用インメモリ実装）

以下はこれを具体化したものである。

---

## 1. `defineFormat`

```typescript
export const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Schema<A, I>
  readonly migrations?: ReadonlyArray<Migration>
}): SaveFormat<A, I>
```

`src/domain/format.ts`。**マイグレーション連鎖に穴があると定義時に throw する。**
実行時のハンドリング対象ではなく、出荷してはいけないビルドだからである。

```typescript
export type Migration = {
  readonly from: number
  readonly describe: string
  readonly migrate: (payload: unknown) => Effect.Effect<unknown, string>
}
```

- ステップは `from → from + 1` の 1 段ずつに限定する。
  任意の `from`/`to` ペアのグラフは O(N²) になり、滅多に通らない辺が腐る。
- 失敗チャネルが `MigrationError` ではなく `string` なのは、
  ステップは「何が失敗したか」は知っていても
  「どのフォーマットのどのバージョン間か」を知らないためである。
  文脈は `migrateToCurrent` が付ける。ステップが自分を誤ラベルできない。

### 連鎖の検証は値としても取れる

```typescript
export const validateMigrationChain = (spec: {...}): ReadonlyArray<string>
```

`expect(() => ...).toThrow()` は「何かが間違っていた」しか主張できないので、
問題をデータとして返す関数を分離してある。

---

## 2. エンベロープ

```typescript
export type SaveEnvelope = {
  readonly format: string
  readonly version: number
  readonly payload: unknown
}
export const SaveEnvelopeSchema: Schema.Schema<SaveEnvelope>
export const FIRST_VERSION = 1
export const isFromFuture: (envelope: SaveEnvelope, currentVersion: number) => boolean
```

`src/domain/envelope.ts`。**バージョンを payload の外側に置く**のが要点である。
これにより `Schema` を通す前にマイグレーションを走らせられる。

### 参照実装との差

| | 参照実装 | mc-save |
| --- | --- | --- |
| チャンクの保存形式 | 生 `Uint8Array` を structured clone でそのまま格納（`storage-service.ts:101-106` → `idb-utils.ts:92-96`） | エンベロープに包む |
| バージョンタグ | 無し | `version` |
| 長さ/形式ヘッダ | 無し | schema が担保 |
| 読み出し時の検証 | 無し（`storage-service.ts:111-115` は生 `db.get` を `Option.fromNullable` するだけ） | `SaveEnvelopeSchema` で decode |

参照実装のバージョン番号は **2 種類あり、どちらも死んでいた**:

- `WORLD_SCHEMA_VERSION = 3` — `storage-idb-model.ts:7` と `packages/world/domain/chunk.ts:9` に**二重定義**。
  `packages/world/index.ts:85-90` からも export されておらず、読む consumer が存在しない。
- `saveVersion` (= `CURRENT_WORLD_SAVE_VERSION = 1`, `world-metadata-model.ts:13`) —
  書き込みは `session-save-metadata.ts:40`、読み出しは
  `session-world-loader.ts:174` の**ログ行 1 箇所のみ**。分岐は一切ない。

---

## 3. コーデック

```typescript
export const encodeSave: <A, I>(format: SaveFormat<A, I>, value: A)
  => Effect.Effect<SaveEnvelope, SaveDecodeError>

export const migrateToCurrent: <A, I>(format: SaveFormat<A, I>, envelope: SaveEnvelope)
  => Effect.Effect<unknown, MigrationError>

export const decodeSave: <A, I>(format: SaveFormat<A, I>, envelope: SaveEnvelope)
  => Effect.Effect<A, SaveDecodeError | MigrationError>
```

`decodeSave` の順序が本質である:

1. `format` 名の一致を確認（不一致は即エラー）
2. **未来のセーブ**なら専用のエラー（破損ではない）
3. マイグレーション連鎖を**生の payload に対して**実行
4. 最後に `Schema.decodeUnknown`

`migrateToCurrent` を独立に export しているのは、
「各ステップがどんな形を作るか」を直接テストできるようにするためである。
最終 schema が受理したかどうかだけでは、途中のステップの正しさは分からない。

---

## 4. エラー

`src/domain/errors.ts`。**参照実装は境界に 1 種類しか出していなかった**（`StorageError`、
`packages/block/domain/errors.ts:6-14`）。`IndexedDBError` も
`storage-error-mapping.ts:7-10` で全部そこへ潰されていた。

その結果、呼び出し側は「ディスクが一杯」「新しいビルドのセーブ」「マイグレーション 2→3 が落ちた」を
区別できず、UI は `` `${worldId} (corrupt)` `` と削除ボタンしか出せなかった
（`packages/presentation/menu/main-menu-handlers.ts:137-142`）。

| 型 | いつ | 呼び出し側の正しい反応 |
| --- | --- | --- |
| `StorageError` | 媒体が失敗した | **リトライ**（参照実装は `Schedule.exponential(100ms)` × 3、クォータ超過で中断 — `storage-error-mapping.ts:12-19`） |
| `SaveDecodeError` | バイト列が期待と違う／未来のセーブ | **拒否して警告**。未来のセーブは削除を提案してはならない |
| `MigrationError` | マイグレーションが落ちた | **バグ報告**。自分たちのコードが間違っている |
| `DuplicateFormatError` | 同名フォーマットの二重登録 | プログラマエラー |

---

## 5. `StoragePort`

```typescript
export type SaveKey = string & Brand.Brand<'SaveKey'>
export const SaveKey: Brand.Brand.Constructor<SaveKey>   // 空文字・空白のみを拒否

export type StorageService = {
  readonly get: (key: SaveKey) => Effect.Effect<Option.Option<SaveEnvelope>, StorageError>
  readonly put: (key: SaveKey, envelope: SaveEnvelope) => Effect.Effect<void, StorageError>
  readonly remove: (key: SaveKey) => Effect.Effect<void, StorageError>
  readonly keys: Effect.Effect<ReadonlyArray<SaveKey>, StorageError>
}

export class StoragePort extends Context.Tag('@nerima-games/mc-save/StoragePort')<
  StoragePort, StorageService
>() {}
```

`keys` が関数でなく値なのは引数を取らないからで、
参照実装も `listWorldMetadata` で同じ区別をしていた（`storage-service.ts:168`）。

### アダプタ

```typescript
export const makeInMemoryStorage: Effect.Effect<StorageService>
export const InMemoryStorageLayer: Layer.Layer<StoragePort>
export const failingStorageLayer: (operation: string) => Layer.Layer<StoragePort>
```

インメモリ実装は**テスト用の便利品ではなく、契約の正典**である。
参照実装は同じものを **5 つ**手書きしていた:

| 実装 | 場所 |
| --- | --- |
| フルサービスの二重化 | `packages/world/test/storage-service-test-utils.ts:49-125` |
| 失敗する二重化 | 同 `:129-189` |
| Port の二重化（chunk manager 用） | `packages/world/test/chunk-manager-test-utils.ts:20-39` |
| Port の二重化（block cycle 用） | `packages/world/test/block-cycle-test-utils.ts:22-34` |
| インラインの 5 個目 | `packages/world/test/storage-service.property.test.ts:30-42`（コメントに「mirrors makeInMemoryStorageService」と自認） |

しかも本命の二重化は Schema decode を**手書きの型ガード**に置き換えていた
（`storage-service-test-utils.ts:30-44`）ため、
テストにおける「corrupt」の意味が本番と一致していなかった。

---

## 6. 組み合わせ

```typescript
export const saveTo: <A, I>(format: SaveFormat<A, I>, key: SaveKey, value: A)
  => Effect.Effect<void, StorageError | SaveDecodeError, StoragePort>

export const loadFrom: <A, I>(format: SaveFormat<A, I>, key: SaveKey)
  => Effect.Effect<Option.Option<A>, StorageError | SaveDecodeError | MigrationError, StoragePort>
```

コーデックと媒体が出会う**唯一の場所**。
鍵が無い場合は `Option.none()` を返す（新規ワールドはエラーではない）。

`loadFrom` は `StoragePort` が型として `SaveEnvelope` を返すにもかかわらず**再検証する**。
バイト列はプロセスの外から来ており、型注釈は実行時の保証ではない。

---

## 7. レジストリ

```typescript
export type AnySaveFormat = SaveFormat<any, any>
export type FormatRegistry = ReadonlyMap<string, AnySaveFormat>

export const emptyRegistry: FormatRegistry
export const registerFormat: (registry: FormatRegistry, format: AnySaveFormat)
  => Either.Either<FormatRegistry, DuplicateFormatError>
export const registerFormats: (registry: FormatRegistry, formats: ReadonlyArray<AnySaveFormat>)
  => Either.Either<FormatRegistry, DuplicateFormatError>
export const lookupFormat: (registry: FormatRegistry, name: string) => Option.Option<AnySaveFormat>
export const describeRegistry: (registry: FormatRegistry)
  => ReadonlyArray<{ readonly name: string; readonly version: number }>
```

immutable な値であり、mutable なシングルトンではない。

`describeRegistry` の出力は名前順にソートされているので **snapshot に取れる**。
この差分が「セーブフォーマットが変わった」というレビュー信号になり、
plan.md §6 Step 0 が求める API ロックファイルのセーブ版として機能する。

`AnySaveFormat` の `any` は手抜きではない。
`Schema.Schema` は両パラメータに対して invariant なので、
`SaveFormat<unknown, unknown>` は `SaveFormat<Chunk, ChunkEncoded>` を受け取れない。

---

<a id="idb"></a>
## 8. 実装済み: IndexedDB アダプタ

`src/domain/indexeddb-storage.ts`。plan.md §3.5 の要求を満たす。

### `lib: ["DOM"]` は足していない — 当初の計画は誤りだった

このセクションは当初「アダプタは自前の tsconfig で隔離した上で追加する」と書いていた。
**隔離は不要だった。** `src/domain/indexeddb-surface.ts` が
アダプタの使う IndexedDB API だけを構造的に記述し、
`test/fixtures/indexeddb-surface.ts` を本物の `lib.dom.d.ts` に対してコンパイルする
テストが「実物の `IDBFactory` がキャスト無しでその型を満たす」ことを証明している。
mc-render `application/dom-surface.ts` / mx-ui と同じ手口である。

別 tsconfig 案を捨てた理由は趣味ではなく機構である。この判断をした当時、
`scripts/api-lock.ts` は `tsconfig.build.json` からレポートを作り、
`scripts/check-dependency-whitelist.ts` は `src/index.ts` と `src/domain/` を出荷対象と見なしていた
（両スクリプトとも org 標準の移行で今は廃止済み — [API_STANDARD.md §4](https://github.com/nerima-games/.github/blob/main/API_STANDARD.md)、
[PACKAGE_STANDARD.md「`scripts/check-dependency-whitelist.ts` の廃止」](https://github.com/nerima-games/.github/blob/main/PACKAGE_STANDARD.md)）。
`tsconfig.build.json` の外に置いたアダプタは `src/index.ts` から re-export できず、出荷対象を
走査する範囲（現在は `oxlint.json` の対象パス `src`）からも外れる —
**実媒体に触る唯一のファイルが、どのゲートからも見えないファイルになる。** この結論自体は、
実効機構が変わった今も変わらない。

### 非自明だった型の性質（触る前に読むこと）

`onsuccess` 等のハンドラ引数が `never` なのは書き間違いではない。
lib.dom はこれらを**プロパティ**として宣言しており、
`strictFunctionTypes` 下では引数が反変になる。
したがって実物の `IDBRequest` が我々の型に代入可能であるためには、
我々の引数型が `Event` の**部分型**でなければならない。
DOM 無しで書ける `Event` の部分型は `never` だけである。
実測した拒否メッセージは `src/domain/indexeddb-surface.ts` 冒頭に記録してある。

**結果としてイベントは読めない。これは仕様である** — 下の「upgrade ハンドラ」を参照。

### ストアレイアウト（このアダプタ自身のもの。参照実装のものではない）

| 項目 | 値 |
| --- | --- |
| DB 名 | **呼び出し側が渡す**（`IndexedDbStorageOptions.databaseName`）。mc-save は `'minecraft-worlds'` を知らない。鍵 `worldId:x:z` を知らないのと同じ理由である |
| レイアウトバージョン | `STORE_LAYOUT_VERSION = 1`。セーブフォーマットのバージョンとは無関係 |
| ストア | `saves` 1 本のみ。`keyPath: 'key'` |
| インデックス | `by-insertion`（`seq` 上）。`keys` が挿入順を返すために必要 |
| レコード | `{ key, seq, envelope }` |

`chunks` / `metadata` は**作らない**。それは参照実装のスキーマであり、
それを知らないことが mc-save の設計そのものである（`src/domain/storage-port.ts` 冒頭）。

### エラーチャネルは広げていない

`StorageService` は `StorageError` を約束しており、全ての失敗が `StorageError` である。
ただしクォータだけは呼び出し側の正しい対応が異なる（リトライしても無駄）ので、
`operation` に `:quota-exceeded` を付し `isQuotaExceeded` で読み戻す。
`blocked` は `indexeddb.open:blocked` と命名する（こちらはリトライが有効なので印は付けない）。

### 参照実装から移植した値

| 項目 | 参照実装の値・場所 |
| --- | --- |

| 項目 | 参照実装の値・場所 |
| --- | --- |
| DB 名 | `'minecraft-worlds'`（`storage-idb-model.ts:8`）。**この定数はゲーム側の持ち物になった。** mc-save は渡された名前をそのまま使うだけである |
| DB バージョン | `DB_VERSION = 2`（`storage-idb-model.ts:9`）。こちらのレイアウトは 1 から数え直す |
| ストア | `'chunks'` / `'metadata'`（`storage-idb-model.ts:10-11`）。**採用しない**（上記） |
| チャンク鍵 | `` `${worldId}:${chunkCoord.x}:${chunkCoord.z}` ``（`storage-idb-model.ts:27-28`）。**採用しない** — 鍵は呼び出し側が綴る |
| IDB ラッパ | `packages/world/infrastructure/idb-utils.ts`（243 LOC） |
| エラーマッピング | `storage-error-mapping.ts`（19 LOC）。`QuotaExceededError` は `DOMException.name` で判定。**これは採用した** |
| 設定用の第 2 DB | `'minecraft-settings'` v1、ストア `'settings'`、単一レコード鍵 `'current'`（`settings-storage-service.ts:5-8`） |

**注意**: 参照実装の設定用アダプタ（`packages/game/infrastructure/settings-storage-service.ts`, 151 LOC）は
`idb-utils.ts` を再利用せず、`requestEffect` / `writeRequestEffect` / `openSettingsDatabase` を手書きで重複実装していた。
mc-save に移植する際は 1 本にまとめること。

### upgrade ハンドラの既知の欠陥

`storage-service.ts:55-62` の upgrade コールバックは `oldVersion` を**無視**している。
`idb-utils.ts:195` はシグネチャに `(db: UpgradeDB, oldVersion: number) => void` を持ち、
`:222` で `event.oldVersion` を渡しているのに、唯一の呼び出し側が引数を捨てている。
結果としてストア作成が冪等に走るだけで、データ書き換えパスは一度も実行されたことがない。

mc-save ではスキーマ移行は `defineFormat` の連鎖が担い、
IndexedDB の `upgrade` はストア構造の変更だけに限定する（責務を混ぜない）。

**そしてこれは型で強制されている。** 上記のとおりハンドラの引数が `never` なので、
`event.oldVersion` は読もうと思っても読めない。
参照実装は同じ規律を偶然守って（`oldVersion` を渡しておきながら捨てて）いたが、
ここでは「守り忘れる」ことができない。

**古いバージョンで書かれた DB がどうなるか**: 開き、欠けていた構造だけを獲得し、
**レコードは 1 件も書き換えられず 1 件も落ちない**。
エンベロープが古いフォーマットバージョンのままでも構わない —
それは `decodeSave` の担当であって媒体の担当ではない。
回帰テストは `test/indexeddb-storage.test.ts` の
「an older database keeps every record it had」。

**この設計の代償**（将来この行を読む人へ）: 既に存在するストアに
後からインデックスを足す変更は、上記の分岐が「ストアがあるか」しか見ないので発火しない。
既存ストアに upgrade 中に触るには `IDBOpenDBRequest.transaction` が要り、
それは今わざと surface に入っていない。
その時の正しい代価は surface と fixture の変更であって、キャストではない。
