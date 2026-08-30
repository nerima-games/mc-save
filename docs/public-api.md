# 公開 API

公開 entry point は `src/index.ts` です。ここに再 export されていない内部 helper は、利用側の契約ではありません。

## Format と envelope

```typescript
type SaveFormat<A, I> = {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Schema<A, I>
}

const defineFormat: <A, I>(spec: SaveFormat<A, I>) => SaveFormat<A, I>
const encodeSave: <A, I>(format: SaveFormat<A, I>, value: A) =>
  Effect.Effect<SaveEnvelopeDraft, SaveDecodeError>
const decodeSave: <A, I>(format: SaveFormat<A, I>, value: unknown) =>
  Effect.Effect<A, SaveDecodeError>
```

`encodeSave` の戻り値は、schema encode 済みだが integrity をまだ持たない draft です。
`saveTo`、`saveBatch`、`saveDurably` は draft を封印してから保存します。
decoder は format name と version を厳密一致で検証し、古い version を別 schema へ変換しません。
新しい version は `SaveDecodeError` として検出され、削除対象とは区別されます。

envelope と integrity の主な公開値は次の通りです。

- `SaveEnvelope`、`SaveEnvelopeDraft`、`SaveIntegrity`
- `SaveEnvelopeSchema`、`SaveEnvelopeDraftSchema`
- `saveEnvelope`、`sealSaveEnvelope`、`validateSaveEnvelope`
- `DEFAULT_MAX_SAVE_BYTES`、`FIRST_VERSION`、`isFromFuture`

`SaveEnvelope` は format、version、payload、canonical payload の byte length、checksum を持ちます。
`sealSaveEnvelope` と `validateSaveEnvelope` は persistence adapter の外でも再利用できます。

## Persistence

```typescript
const saveTo: <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  value: A,
  options?: SaveWriteOptions,
) => Effect.Effect<void, StorageError | SaveDecodeError, StoragePort>

const loadFrom: <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  options?: SaveReadOptions,
) => Effect.Effect<Option.Option<A>, StorageError | SaveDecodeError, StoragePort>

const listFrom: <A, I>(
  format: SaveFormat<A, I>,
  options?: SaveReadOptions,
) => Effect.Effect<SaveListing<A>, StorageError, StoragePort>
```

欠損 key は `Option.none()` です。媒体から戻った envelope は型注釈を信用せず、`loadFrom` と
`listFrom` で再検証します。`listFrom` は媒体エラーを Effect の失敗として返し、個々の破損は
`SaveListing.corrupt` に残して他の key を読み続けます。

複数保存と durable 保存も公開されています。

- `saveBatchEntry` と `saveBatch`: 全 entry の encode・封印後に `commitBatch` を一度実行する原子的な書き込み
- `saveDurably` と `loadDurably`: 現行値と予約 suffix の previous 値を使う durable 操作
- `SaveWriteOptions`: `extensions` と `maxBytes`
- `SaveReadOptions`: `maxBytes`

## Key と StoragePort

```typescript
type StorageService = {
  readonly get: (...) => Effect.Effect<Option.Option<SaveEnvelope>, StorageError>
  readonly put: (...) => Effect.Effect<void, StorageError>
  readonly remove: (...) => Effect.Effect<void, StorageError>
  readonly commitBatch: (...) => Effect.Effect<void, StorageError>
  readonly readBatch: (...) => Effect.Effect<ReadonlyArray<Option.Option<SaveEnvelope>>, StorageError>
  readonly keys: Effect.Effect<ReadonlyArray<SaveKey>, StorageError>
}
```

`StoragePort` はこの 6 操作だけを要求します。標準実装は `makeInMemoryStorage`、
`InMemoryStorageLayer`、`makeIndexedDbStorage`、`indexedDbStorageLayer` です。
`SaveKey` と `saveKeyForWorld` は空白 key と path traversal を防ぎ、`WorldId` は
`@nerima-games/mc-kernel` の型を直接利用します。

IndexedDB の store layout version は save format version と別管理です。IndexedDB adapter は
sequence index、atomic batch、expected-value conflict、quota error mapping を実装します。

## Registry と errors

`emptyRegistry`、`registerFormat`、`registerFormats`、`lookupFormat`、`describeRegistry` は、
同名 format の登録を `DuplicateFormatError` で拒否する immutable registry API です。
registry に migration chain はありません。

公開 error は `StorageError`、`SaveDecodeError`、`DuplicateFormatError` です。媒体障害、
保存データの不一致、format の重複を呼び出し側が別々に扱えます。

## Minecraft Java codec

次の API は保存媒体とは独立した wire/container 境界です。

- `encodeNbt` / `decodeNbt`、NBT tag types、modified UTF-8
- `compressMinecraft` / `decompressMinecraft`、gzip・zlib・none・LZ4 block stream
- `encodeAnvilRegion` / `decodeAnvilRegion`、8 KiB header と 4 KiB sector の Anvil region
- `encodeMinecraftRegionFiles` / `decodeMinecraftRegionFiles`、external `.mcc` chunk
- `minecraftDimensionDirectory`、Java 26.1 の dimension/region 座標、local chunk 座標、`.mca` / `.mcc` path
- `minecraftLevelDataPath`、`minecraftLevelDataBackupPath`、`minecraftIconPath`、
  `minecraftSessionLockPath`、playerdata・stats・advancements・data・map・command storage path helpers

これらは Java 26.1 のバイト列、圧縮、container、標準 path を扱います。Anvil の圧縮 ID `127` は
`custom` として名前空間付きアルゴリズム名を含む未解釈バイト列を保持しますが、任意の custom
アルゴリズムをこのライブラリが解凍するわけではありません。プレイヤーやチャンクの意味論 schema
は consumer が `defineFormat` で定義します。
