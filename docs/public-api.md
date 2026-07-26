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

`domain/format.ts`。**マイグレーション連鎖に穴があると定義時に throw する。**
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

`domain/envelope.ts`。**バージョンを payload の外側に置く**のが要点である。
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

`domain/errors.ts`。**参照実装は境界に 1 種類しか出していなかった**（`StorageError`、
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
## 8. 未実装: IndexedDB アダプタ

plan.md §3.5 は `StoragePort` の IndexedDB 実装を要求しているが、
スケルトン段階では**意図的に入れていない**。

理由: `lib: ["DOM"]` を `tsconfig.base.json` に足した瞬間、
「このツールキットは platform-free である」ことを `pnpm typecheck` で証明できなくなる。
アダプタは自前の tsconfig で隔離した上で追加する。

### 実装時に移植すべき内容

| 項目 | 参照実装の値・場所 |
| --- | --- |
| DB 名 | `'minecraft-worlds'`（`storage-idb-model.ts:8`）。**`'ts-minecraft'` ではない** |
| DB バージョン | `DB_VERSION = 2`（`storage-idb-model.ts:9`） |
| ストア | `'chunks'` / `'metadata'`（`storage-idb-model.ts:10-11`） |
| チャンク鍵 | `` `${worldId}:${chunkCoord.x}:${chunkCoord.z}` ``（`storage-idb-model.ts:27-28`）。メタデータ鍵は素の `worldId` |
| IDB ラッパ | `packages/world/infrastructure/idb-utils.ts`（243 LOC） |
| エラーマッピング | `storage-error-mapping.ts`（19 LOC）。`QuotaExceededError` は `DOMException.name` で判定 |
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
