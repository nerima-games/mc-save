# アーキテクチャ

## レイヤー

mc-save は、ゲームの状態を知らない保存基盤です。

| レイヤー | 主なモジュール | 責務 |
| --- | --- | --- |
| format | `format*.ts`、`format-definition.ts` | schema、名前、現行 version、encode/decode |
| integrity | `envelope.ts`、`integrity*.ts` | canonical bytes、checksum、サイズ、sealed 値 |
| persistence | `persistence.ts`、`save-preparation.ts`、`batch-save.ts` | codec と Port の接続、単件・一括操作 |
| adapter | `storage-port.ts`、`indexeddb-*.ts`、`durable-save.ts` | 媒体、atomic commit、durable record、retry |
| Minecraft codec | `minecraft-*.ts`、`anvil-region.ts` | Java wire format と container の再利用可能な実装 |

## 依存方向

~~~mermaid
graph TD
  kernel["mc-kernel"]
  format["format / integrity"]
  persistence["persistence / batch / durable"]
  adapter["StoragePort / IndexedDB"]
  minecraft["Minecraft wire / container"]
  consumer["ゲーム側 consumer"]

  format --> kernel
  persistence --> format
  persistence --> adapter
  minecraft --> kernel
  consumer --> format
  consumer --> persistence
  consumer --> minecraft
~~~

mc-save の直接 runtime dependency は `effect` と `@nerima-games/mc-kernel` です。
mc-kernel から `WorldId`、`ChunkCoord`、`ChunkAxis`、`CHUNK_SIZE_XZ` を再利用し、
識別子検証と座標計算を重複実装しません。依存境界は `.oxlintrc.json` でも検査します。

consumer が `mc-worldgen` や `mc-sim` の domain schema を mc-save に持ち込むことはありません。
逆方向の import が必要になった場合は、保存層ではなく責務分割を見直します。

## 保存データフロー

~~~text
typed value
  -> Schema encode
  -> draft envelope
  -> canonical bytes / checksum / size validation
  -> sealed envelope
  -> StoragePort
  -> IndexedDB or another adapter
~~~

読み込みは逆方向ですが、媒体から戻った値をまず runtime schema と integrity で検証します。
TypeScript の型注釈だけを信頼しないことが重要です。

## IndexedDB の境界

IndexedDB の database/store/index 名、layout version、record 変換、transaction error mapping は
`indexeddb-layout.ts`、`indexeddb-records.ts`、`indexeddb-runtime.ts` に分離しています。
`indexeddb-surface.ts` は必要な DOM API の型だけを構造的に表現し、Node 側の型環境へ DOM 全体を
持ち込みません。Node の fake IndexedDB と Chromium の実 IndexedDB は同じ Port 契約を検証します。

IndexedDB の内部 layout version と save format version は独立しています。layout upgrade は
adapter の実装変更であり、旧版 save payload を現行 schema へ変換する migration ではありません。

## Minecraft の境界

NBT は tag の wire codec、Anvil は region header・chunk record・sector packing・compression の
container codec です。どの tag を level data や chunk payload として保存するかは consumer が
決めます。標準 path helper は公式 Java の directory/resource 規則に対応するための純粋関数です。
