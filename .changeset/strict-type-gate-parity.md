---
'@nerima-games/mc-save': minor
---

tsconfig の strictness を mc-kernel と揃えました。`tsconfig.base.json` に `strictBuiltinIteratorReturn` と `isolatedDeclarations` を追加しています。

`isolatedDeclarations` は export された宣言を他ファイルからの推論で書けないことを要求するため、公開 `.d.ts` の記述が書き換わります。error クラスは `Data.TaggedError('X')<{...}>` をそのまま `extends` できず、tag constructor を名前付き const に束縛して解決済みの shape を注釈する形になりました。`StoragePort` も同じ理由で `Context.TagClass` 経由の基底になります。mc-kernel の `ClockPort` と同じ形です。

これは型注釈の付け替えであり、公開 API の意味論の変更ではありません。`_tag` literal、field 名・型・optionality、`message` getter、export 一覧はそのままです。生成される `.d.ts` と `.js` の差分は、class の基底が同じ constructor を指す名前付き const になったことだけです。dist を一時 consumer から import して、constructor の引数、`_tag`、`message`、Layer 注入、定数の型（`DEFAULT_NBT_CODEC_OPTIONS` は `maxBytes: number`、他 3 フィールドは literal 型を維持）が変わっていないことを確認しました。

算術で定義された定数、parameter の default 引数、`fixedUint8Array` の `Schema.filter` 戻り値、`SaveKey` の `Brand.refined` constructor、`DEFAULT_NBT_CODEC_OPTIONS` にも注釈を足していますが、どれも生成される宣言は変更前と一致します。`pnpm verify`、`test:coverage`（4 指標 100%）、`test:browser`、`package:verify` 通過。
