# 検証方針

## 標準ゲート

リポジトリの検証は次の順で行います。各コマンドの実測結果と選択テスト数を最終報告の根拠にします。

```text
pnpm typecheck       TypeScript の production / test 境界
pnpm check:source-policy production source の import / runtime policy
pnpm lint            oxlint
pnpm test            Node 環境の unit / contract test
pnpm test:coverage   branches/functions/lines/statements の 100% 閾値
pnpm test:browser    Chromium 上の IndexedDB contract test
pnpm build           release declaration / JavaScript artifact
pnpm package:verify  pack 後の exports・files・一時 consumer
pnpm verify          上記の production 開発ゲート
nix flake check --all-systems  flake の評価と check
```

`pnpm verify` は型検査、source policy、lint、Node test を実行します。coverage、browser、
package boundary、flake は独立したゲートとして実行します。長時間の browser/build は途中で
終了した場合に成功扱いにせず、exit status と runner の assertion output を確認します。

## テスト層

- pure codec: envelope、integrity、binary、NBT、UTF-8、compression、LZ4
- Java container: Anvil region、sector allocation、external `.mcc`、Minecraft path
- persistence: format strictness、再検証、一覧の corrupt 分離、batch atomicity、durable rollback
- adapter contract: in-memory、fake IndexedDB、Chromium IndexedDB
- boundary: 公開 export、release build、pack tarball の一時 consumer
- source policy: mc-kernel と effect 以外の production import 境界、Node/browser 分離

共通の `StoragePort` contract test は adapter ごとに同じ振る舞いを検証します。fake IndexedDB
は高速な異常系、Chromium は実 DOM IndexedDB の transaction 経路を担当します。

## coverage 100%

ユーザー要件に合わせ、coverage 閾値は branches、functions、lines、statements の全てを
100% にします。型だけの browser surface declaration など、実行可能な source でない範囲は
設定上の除外対象ですが、除外理由を設定とテスト構成で確認できる状態に保ちます。

coverage の値はドキュメントに固定せず、`pnpm test:coverage` の現在の出力を正とします。
新しい分岐を追加したら、正常系だけでなく拒否・境界値・外部入力の失敗をテストします。

## 受け入れ範囲と残る統合確認

この repository のテストは、保存契約と Java 26.1 wire/container の境界を検証します。特定ゲームの
player/chunk NBT schema、ゲーム全体の tick、実際の vanilla ワールドを起動する end-to-end
検証は consumer または別の integration suite の責務です。したがって codec が扱えることと、
公式ゲームが生成した全ての意味論 payload を解釈できることを同一視しません。
