# 移植と責務の境界

## 移植した層

この repository は、ゲーム固有の domain を丸ごと取り込むのではなく、複数 consumer が共有できる
保存の境界を管理します。

- `src/domain/format*.ts`: schema と strict format codec
- `src/domain/envelope.ts`、`integrity*.ts`: envelope、canonical bytes、checksum
- `src/domain/persistence.ts`、`batch-save.ts`、`durable-save.ts`: Effect persistence
- `src/domain/storage-port.ts`、`indexeddb-*.ts`: adapter Port と IndexedDB
- `src/domain/minecraft-*.ts`、`anvil-region.ts`、`minecraft-region-files.ts`: Java wire/container
- `src/domain/minecraft-paths.ts`: save directory path と coordinate mapping

これらの層は値の意味を知らず、検証可能な bytes・container・storage transaction を提供します。

## 移植しない層

次は consumer の責務です。

- player、chunk、world metadata の意味論 schema
- tick、autosave、session lifecycle
- rendering、UI、入力、ゲームルール
- domain object の cache と event orchestration
- 旧版 payload を新 schema に変換する product-specific policy

この分離により、mc-save は保存方式の重複を減らしながら、consumer の domain model を固定しません。

## `mc-kernel` の再利用

保存 key と Minecraft path の座標処理は `@nerima-games/mc-kernel` の `WorldId`、`ChunkCoord`、
`ChunkAxis`、`CHUNK_SIZE_XZ`、`chunkCoord` を直接利用します。mc-save 内に同等の座標型や
chunk サイズ定数を複製しないことが依存境界です。

## 実装を利用する入口

consumer は次の順に API を選びます。

1. `defineFormat` で payload schema を定義する
2. `saveKeyForWorld` または `SaveKey` で key を作る
3. `saveTo` / `loadFrom`、必要なら `saveBatch` / `saveDurably` を使う
4. 実行環境で `InMemoryStorageLayer` または `indexedDbStorageLayer` を提供する
5. Java file を扱う場合だけ NBT・compression・Anvil codec を直接使う

意味論 schema を mc-save に追加したり、内部 helper を consumer から import したりしません。
