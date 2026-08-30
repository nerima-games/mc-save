# mc-save ドキュメント

このディレクトリは、現行実装の責務・公開 API・検証方法を説明します。
ソースと `package.json` が契約の正本であり、文書はその読み方を補足します。

## 読む順序

| ファイル | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | レイヤー、依存境界、データフロー |
| [responsibility.md](./responsibility.md) | mc-save、mc-kernel、consumer の責務 |
| [public-api.md](./public-api.md) | 公開 entry point と主要な API |
| [design-notes.md](./design-notes.md) | 重要な不変条件と設計判断 |
| [porting.md](./porting.md) | 移植した責務と移植しない責務 |
| [testing.md](./testing.md) | 型、lint、テスト、coverage、browser、package の検証 |
| [versioning.md](./versioning.md) | package version と save format version の運用 |

## 現行契約

### フォーマット

consumer は `defineFormat` で名前・整数 version・`effect/Schema` schema を登録します。
`encodeSave` は schema を encode した draft envelope を返します。`saveTo`、`saveBatch`、
`saveDurably` が integrity を付けた sealed envelope を永続化します。decoder は format name と
version を厳密に検査し、旧版を自動変換しません。sealed envelope の組み立て用 helper は内部実装です。

### 保存

`StoragePort` は key と sealed envelope だけを扱います。format の意味論、key の命名、保存する
タイミングは consumer が決めます。単件、batch、durable、retry の操作は同じ Port 境界を使います。

### Minecraft

低レベル codec として Java modified UTF-8、NBT、gzip/zlib/none/LZ4、Anvil region、
external `.mcc` を提供します。標準パス helper は level data、icon、session lock、player data、
stats、advancements、map、command storage、region/entities/poi を扱います。

このパッケージは vanilla の全てのゲーム意味論 schema を定義するものではありません。
Anvil の payload と NBT の tag 構造を consumer が選べるようにする層です。

## 検証

通常の変更は次の順で確認します。

~~~console
pnpm typecheck
pnpm check:source-policy
pnpm lint
pnpm test
pnpm test:coverage
pnpm typecheck:browser
pnpm test:browser
pnpm package:verify
nix flake check --all-systems
~~~

各コマンドの意味と、選択テスト数・coverage の読み方は [testing.md](./testing.md) にあります。
