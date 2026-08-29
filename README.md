# @nerima-games/mc-save

`@nerima-games/mc-save` は Minecraft のセーブデータを扱う TypeScript ライブラリです。
保存対象のゲーム意味論は持たず、現行版専用の format codec、整合性付き envelope、
保存 Port、Java 版の wire/container codec を提供します。

## 責務

このリポジトリが所有するものは次の境界です。

- `Effect` ベースの現行版専用 format codec と format registry
- サイズ制限、canonical bytes、checksum を含む envelope の検証
- `StoragePort`、インメモリ実装、IndexedDB 実装、batch/durable 操作、retry wrapper
- Java 26.1 の modified UTF-8、NBT、gzip/zlib/none/LZ4、Anvil region、`.mca`/`.mcc`、標準パス helper
- `mc-kernel` の `WorldId`、`ChunkCoord`、`ChunkAxis`、`CHUNK_SIZE_XZ` の再利用

チャンク・プレイヤー・ワールドの意味論 schema、保存タイミング、ゲーム状態の更新は consumer が
定義します。mc-save は特定のゲームドメインを import しません。

## セットアップ

~~~console
nix develop
pnpm install --frozen-lockfile
~~~

Nix を使わない場合は Node.js 24 以上と pnpm 11 以上を用意してください。バージョンは
`package.json` の `engines` と `packageManager` が正です。

## API の最小例

~~~typescript
import { Effect, Schema } from 'effect'
import { defineFormat, InMemoryStorageLayer, SaveKey, saveTo } from '@nerima-games/mc-save'

const PlayerFormat = defineFormat({
  name: 'player',
  version: 1,
  schema: Schema.Struct({ health: Schema.Number }),
})

await Effect.runPromise(
  saveTo(PlayerFormat, SaveKey('player'), { health: 20 }).pipe(
    Effect.provide(InMemoryStorageLayer),
  ),
)
~~~

`saveTo` は schema で値を encode し、canonical bytes・checksum・サイズ制限を検証した sealed
envelope を保存します。`encodeSave` は整合性をまだ付けていない draft を返します。
format version は厳密一致で判定され、異なる version の payload を自動変換しません。

## 構成

~~~text
src/index.ts                         公開 entry point
src/domain/format*.ts                format 定義・codec・検証
src/domain/envelope.ts               envelope の構造
src/domain/integrity*.ts             canonical bytes・checksum・サイズ検証
src/domain/persistence.ts            codec と StoragePort の接続
src/domain/storage-port.ts           保存媒体の Port と in-memory adapter
src/domain/indexeddb-*.ts            IndexedDB の layout・runtime・adapter
src/domain/batch-save.ts             複数保存の準備と atomic commit
src/domain/durable-save.ts           durable save/load
src/domain/minecraft-*.ts            Java wire/container codec と標準パス
src/domain/anvil-region.ts           Anvil region container
test/                                Node・fake IndexedDB・Chromium の検証
docs/                                実装と運用の説明
~~~

## 開発と検証

~~~console
pnpm verify
pnpm test:coverage
pnpm test:browser
pnpm package:verify
nix flake check --all-systems
~~~

`pnpm verify` は型検査、source policy、lint、Node テストを実行します。`test:coverage` は
branches/functions/lines/statements の 100% 閾値を検査し、`test:browser` は Chromium の実 IndexedDB
を検査します。配布物の境界は `package:verify` で pack 後の一時 consumer から確認します。

## 設計上の境界

- 保存する sealed envelope は現行 format version と integrity 情報を持ちます。
- `encodeSave` は draft を返し、`saveTo`・`saveBatch`・`saveDurably` は sealed envelope を永続化します。
- 読み込み時は保存媒体から得た値を再検証し、破損・future version・不一致 version を明示的な error にします。
- Minecraft の意味論 schema はこのパッケージに含めません。NBT/Anvil payload に何を入れるかは consumer が決めます。
- IndexedDB の内部 store layout version は save format version と別の実装バージョンです。
- 旧版セーブを現行版へ自動変換する migration chain は提供しません。

## License

MIT
