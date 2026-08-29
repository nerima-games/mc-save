# バージョニング

## 二つの版

package version と save format version は別の契約です。

| 版 | 意味 | 定義場所 |
| --- | --- | --- |
| package version | npm package の配布版 | `package.json` の `version` |
| format version | 個別 payload schema の現行世代 | `defineFormat({ version })` |

package version を上げても format version は自動では変わりません。format version を変える
場合は schema、fixture、consumer の release 判断を同時に更新します。

## 現行 format 契約

format は name と version の厳密な組み合わせです。`decodeSave` は次を拒否します。

- 別 format の envelope
- 現行より新しい future version
- 現行と異なる過去 version
- integrity、byte length、payload schema が不正な envelope

旧版を現行版へ自動変換する migration chain はありません。互換性を提供しない版を現行
実装として選ぶ場合、consumer は必要なデータを明示的に再生成・再保存する運用を持つ必要があります。
この拒否は、解釈できないデータを破損データとして上書き・削除しないためのものです。

## IndexedDB layout version

IndexedDB の object store、index、record layout の版は save format version と別です。layout
upgrade は adapter 内部の保存媒体契約であり、Minecraft payload の schema migration ではありません。
layout upgrade 後も envelope の format/version/integrity 検証は変わりません。

## package release

package の `engines`、`packageManager`、lockfile、exports、changeset を release artifact の
入力とします。変更を公開する場合は、少なくとも次を同じ変更単位で確認します。

1. source と declaration の public export が一致している
2. `pnpm verify`、coverage、browser、`package:verify` が通る
3. package version と changeset の意図が一致している
4. consumer が使用する `@nerima-games/mc-kernel` version と lockfile が再現可能である

この repository では `pnpm changeset status` で release 状態を確認し、publish 自体は release
承認がある作業でのみ実行します。
