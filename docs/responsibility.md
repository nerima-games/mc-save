# 責務の境界

## mc-save が所有するもの

- `effect/Schema` を使った format 定義と strict version decode
- draft / sealed envelope、canonical bytes、checksum、byte-size limit
- `StoragePort` と in-memory / IndexedDB adapter
- 単件、batch、durable、retry の persistence effect
- `SaveKey` の検証と world key の共通レイアウト
- Minecraft Java の NBT、modified UTF-8、compression、Anvil region、external `.mcc` の wire/container
- Java save directory の標準 path helper

ここでいう保存データは「どの値を保存するか」ではなく、値を安全に符号化し、検証し、媒体へ
渡す境界です。ストレージから読み出した値は外部入力として毎回再検証します。

## `mc-kernel` に委譲するもの

`@nerima-games/mc-kernel` が既に定義する共有値を再定義しません。

- `WorldId`
- `ChunkCoord`、`ChunkAxis`
- `CHUNK_SIZE_XZ`
- `chunkCoord` の座標検証

これにより、保存層とシミュレーション・worldgen 間で座標表現が分裂しません。mc-save は
kernel のゲーム意味論や clock を取り込まず、保存 path と container の計算に必要な共有型だけを使います。

## consumer が所有するもの

- player、chunk、world metadata などの意味論 schema
- payload のフィールドとゲーム固有の validation
- save のタイミング、autosave policy、ロード後の domain object への復元
- UI の warning、retry、future version の案内
- どの format name/version を release するか

consumer は `defineFormat` で schema を定義し、`saveTo` / `loadFrom` または durable API を
選択します。mc-save は consumer 固有の adapter や互換 migration を追加しません。

## 依存方向

```text
mc-kernel ───────┐
                 ├──> mc-save ───> effect / platform IndexedDB
consumer schema ─┘          └────> Java wire/container codec
```

依存は保存契約へ向かい、mc-save が consumer の domain module を import する逆方向はありません。
公開 import の許可範囲は `.oxlintrc.json` と `src/index.ts` が機械的な境界です。

## 移植判断

移植したのは汎用の保存・IndexedDB・Java wire/container の責務です。ゲーム固有の
session、chunk manager、inventory、UI、意味論 schema はこの repository の責務ではありません。
同じ処理を別 repository が再実装する場合は、まずこの公開 Port・codec・path helper を利用し、
独自の保存 envelope や座標型を増やさないことを前提にします。
