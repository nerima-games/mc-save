# 設計ノート

## DN-1: format version は厳密一致

`decodeSave` は format name と version を確認し、future version と current version 以外を
拒否します。旧版を暗黙に読み替えると、保存データがいつ変換されたか追跡できず、失敗時の
復旧判断も壊れます。version を上げるときは consumer が新しい format を定義し、必要なら
明示的な外部変換を所有します。

## DN-2: draft と sealed を分ける

`encodeSave` の結果は schema 変換済みの draft です。`prepareSave` が canonical bytes、
checksum、サイズ制限を検証して sealed envelope にします。保存 Port が受け付ける型を sealed
だけにすることで、整合性検証前の値が永続化境界へ流れません。

## DN-3: canonical bytes は integrity の共通境界

checksum は payload の意味ではなく、保存 envelope の canonical representation に対して計算
します。encode、seal、decode、IndexedDB record の各経路が同じ canonical bytes を使い、
JSON の property order や runtime object identity に依存しないようにします。

## DN-4: 外部から戻る値は必ず再検証する

`StoragePort` の戻り値は TypeScript 上では envelope でも、実体は IndexedDB など外部媒体から
戻った unknown なデータです。`loadFrom` は envelope schema、サイズ、checksum、format schema の
順で検証します。壊れた 1 record を扱う `listFrom` は、媒体全体の failure と record 単位の
decode failure を分離します。

## DN-5: atomic batch は Port の責務

`commitBatch` は全 mutation を順に検証し、途中で失敗した場合は変更前の snapshot を残します。
batch preparation は codec 側、commit の atomicity は adapter 側という分離により、複数 record
保存でも IndexedDB と in-memory の意味を揃えます。

## DN-6: durable save は通常 key と分離する

durable save は保存中断後の復旧に使う一時 key と previous key を持ちます。通常の listing から
復旧用 key を除外し、commit 後にのみ昇格させます。durable の一時状態は save format version の
migration ではありません。

## DN-7: retry は媒体ではなく Port wrapper に集約する

`withStorageRetry` は全 Port 操作に同じ schedule と判定関数を適用します。quota error など
retry 可能かどうかは媒体固有なので、`StorageRetryPolicy` として明示的に注入します。
呼び出し側ごとに retry を書くと、put と batch で挙動がずれます。

## DN-8: Java codec は意味論から独立させる

modified UTF-8、NBT、圧縮は Java wire format の実装です。NBT の schema や tag の用途は
consumer が決め、mc-save は特定の world/player model を import しません。深さ・サイズ・
文字列長の上限は codec options で明示します。

## DN-9: Anvil は byte layout を検証する

Anvil region は 32 x 32 chunk の index、8 KiB の header、4 KiB sector 単位の record、
compression id、payload length、padding を扱います。大きい payload の external
`.mcc` record と region/entity/poi の path も同じ container 層で検証します。

## DN-10: パスと座標は純粋関数にする

dimension directory、region coordinate、負数座標の floor division、region 内 local coordinate、
player id などの path segment 検証は `minecraft-paths.ts` に集約します。座標の型と chunk size は
`mc-kernel` から再利用し、consumer の保存処理が同じ規則を再実装しないようにします。

## 回帰テストの対応

設計判断は次のテスト群で固定します。

- format/envelope/integrity: `test/format-roundtrip.test.ts`、`test/durable-save.test.ts`
- batch/Port/retry: `test/batch-save.test.ts`、`test/storage-port.test.ts`、`test/storage-retry.test.ts`
- IndexedDB layout/runtime: `test/indexeddb-*.test.ts`、`test/browser/`
- Java codec: `test/minecraft-*.test.ts`、`test/anvil-region.test.ts`、`test/minecraft-region-files.test.ts`
- path/key: `test/minecraft-paths.test.ts`、`test/save-key.test.ts`
