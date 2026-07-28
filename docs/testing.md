# テストと完了条件

## 1. コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json`（出荷ソース）と `tsconfig.test.json`（テスト+ツール）の両方 |
| `pnpm lint` | oxlint。このリポジトリ唯一の lint/format 設定（prettier も biome も .editorconfig も置かない）。**`--deny-warnings` 付きで走る**ため、`warn` のルールもビルドを落とす（`oxlint.json` は 5 カテゴリすべてと個別 67 ルールが `warn`、`error` は 4 つだけ。このフラグが無かった頃は実質その 4 つしかゲートになっていなかった） |
| `pnpm check:deps` | 依存ホワイトリスト + 循環検査 + `Date.now()` 禁止 |
| `pnpm test` | vitest（`@effect/vitest` の `it.effect` が主 API） |
| `pnpm test:coverage` | カバレッジ計測。**閾値は未設定**（後述） |
| `pnpm verify` | 上記 4 つ（coverage 以外）。CI と同一内容 |

`pnpm` は PATH に無い場合がある。`corepack pnpm <cmd>` で 9.15.0 が起動する。

## 2. 現状のテスト

```
test/format-roundtrip.test.ts    12 tests   コーデックのラウンドトリップ、連鎖検証
test/migration.test.ts            8 tests   マイグレーション（リネームを含む）、Port 経由のロード
test/storage-port.test.ts         8 tests   StoragePort の契約テスト
test/dependency-policy.test.ts   19 tests   16 リポジトリのグラフ、import ゲート、時計禁止
                                 ─────
                                 47 tests   全て green
```

### 契約テストという書き方

`test/storage-port.test.ts` の assertion は全て `StoragePort` **インターフェースに対して**書いてある。
実装（インメモリ）に対してではない。
**IndexedDB アダプタが来たので、実際に再実行している**: 契約ブロック本体は
`test/storage-port-contract.ts` に移り、インメモリと IndexedDB の両方に対して走る。
assertion は 1 つも変えていない。

**そしてこれがバグを 1 つ捕まえた。** `keys` は「挿入順」と規定されているが
IndexedDB の列挙は**キーの昇順**なので、素直な実装は正しい集合を誤った順序で返す。
アダプタが `by-insertion` インデックスを持つのはこのためである。
契約を実アダプタに対して回さなければ気付けなかった —
参照実装の 5 つの未検証二重化が起こしていたのは、まさにこれである。

参照実装はこれをやっていなかった。5 つの手書き二重化があり
（[public-api.md](./public-api.md) §5）、どれも実アダプタと突き合わせられていなかった。
実ブラウザでの契約テストは `e2e/contracts/storage-service-contract-runner.ts` に
36 LOC だけ存在したが、ユニットテスト側の二重化とは別物だった。

## 3. plan.md §3.5 が要求する検証

> **検証**: ラウンドトリップテスト + マイグレーションテスト +
> **旧セーブ fixture との互換テスト**（参照実装の fixture を資産として移植）

| 要求 | 状態 |
| --- | --- |
| ラウンドトリップテスト | ✅ `test/format-roundtrip.test.ts` |
| マイグレーションテスト | ✅ `test/migration.test.ts` |
| 旧セーブ fixture との互換テスト | ✅ `test/legacy-save-compat.test.ts`（10 件）。**参照実装に fixture は無いままである**（[design-notes.md](./design-notes.md#dn-2)）ので、移植ではなく**新規作成した** —— §3.1 |

### 3.1 fixture を「移植できない」まま作った方法

要求は「参照実装の fixture を資産として移植」だが、**移植元は無い**。
参照実装にはバージョン管理そのものが無く（[envelope.ts](../domain/envelope.ts) の冒頭:
バージョン番号は 2 つあってどちらも分岐に読まれていない）、
旧セーブ fixture という概念が成立していなかった。**この事実は変わっていない。**

代わりに、このリポジトリが**自分のフォーマットについて**書き出した。

| 部品 | 場所 | 役割 |
| --- | --- | --- |
| 凍結された歴代フォーマット定義 | `test/support/player-format-history.ts` | v1 / v2 / v3 を `defineFormat` で保持。**編集禁止**（そのファイルのヘッダに理由） |
| 書き出す仕組み | `scripts/write-save-fixtures.ts`（`pnpm fixtures:write`） | §4-2 の「手書き JSON は禁止」を満たす。全バイトが `encodeSave` の出力 |
| ゴールデン fixture | `test/fixtures/saves/player-v{1,2,3}.json` | commit 済み |
| ゲート | `test/legacy-save-compat.test.ts` | 下記 |

**`pnpm verify` は書き出しを走らせない。** 検証が再生成を兼ねると、
出力を変える変更が fixture を書き換えて green になる —— ゴールデンテストを無価値にする典型である。
書き出しは人間の決定、突き合わせは自動、と分けてある。

**`test/migration.test.ts` との違いが要点である。** あちらは v1 ペイロードを
**テストの中で組み立てて**移送するので、示せるのは「この build が思う v1 を、この build が読める」
という自己整合性までである。こちらは**ディスクから読んだバイト**から始まる。
壊れた移送に合わせて「v1 はこうだったことにする」と直す変更は、
前者では 1 つの整合した変更として green のまま通り、後者では commit 済みファイルが動かないので落ちる。

**ミューテーション実測**（2026-07-28、4 件とも赤になることを確認して戻した）:

| 入れた変更 | 落ちたテスト |
| --- | --- |
| v1→v2 の移送が `health` ではなく `hitpoints` に改名 | v1 の行 1 件 |
| `dimension` の既定を `overworld` → `nether` | v1 と v2 の行 2 件 |
| commit 済み v1 fixture の値を書き換え（`hp` 17→11） | 3 件（復号・形状・ドリフト） |
| v1 fixture を**現行 shape で再スタンプ**（version 1 のまま payload だけ v3） | 3 件（同上） |

最後の 1 件が、この構成が実際に何を守っているかを示している ——
3 つの fixture を全部現行フォーマットで書き出せば、
バージョン番号だけ違う同一ペイロードが 3 つ commit され、
**移送は 1 ステップも実行されないまま「全バージョン互換」と報告される**。
`the committed fixtures carry the OLD shapes, not re-stamped modern ones` がそれを閉じている。

## 4. 完了条件

このリポジトリが「完成」と言えるのは以下が全て満たされたときである。

1. `pnpm verify` が green
2. **バージョンごとのゴールデン fixture が commit されている** —— **機構は満たした（§3.1）。対象がまだ 1 つ足りない**
   - fixture を**書き出す仕組み**も同時にある（手書き JSON は禁止。
     「現行コードが出力するもの」ではなく「人が出力すると思ったもの」を固定してしまう）
     → ✅ `pnpm fixtures:write`
   - フォーマットが持ったことのある全バージョンに fixture がある
     → ✅ ただし**現時点で存在するフォーマットは `test/support/player-format-history.ts` の
     1 つだけ**である。テストが「全バージョン」を強制する仕掛け
     （`FORMAT_HISTORY` の長さ = 現行バージョン）は入っているので、
     **実フォーマットが増えたときに同じ形を繰り返すこと**。
     残っているのは条件 4 —— mc-worldgen が実際に `defineFormat` を使う日であり、
     そのとき本項は「そのフォーマットにも fixture があるか」に変わる
3. ~~**IndexedDB アダプタが実装され**~~、契約テストが実ブラウザで green
   （アダプタは済。契約テストは fake に対しては green。実ブラウザ実行が残り）
   - `test/storage-port.test.ts` を実アダプタに対して再実行できる
4. **mc-worldgen が実際に `defineFormat` でチャンクフォーマットを定義し、消費している**
   - ツールキットは消費者なしには正しさを主張できない
5. カバレッジ 99% ゲートが有効化されている（後述）

プレビューは無い。UI を持たないリポジトリだからである
（plan.md §2.3-4 の「プレビューは検証対象と同居する」の対象外）。

## 5. カバレッジ閾値: 今はまだ設定しない

参照実装は branches / functions / lines / statements の 99% を強制している。
mc-save でも**最終的には同じ 99% を課す**が、今は課さない。

理由: スケルトンに閾値を課しても意味が無い。
型定義だけのモジュールをいくつか置けば簡単に満たせてしまい、
実装の品質について何も語らない数字になる。

現状:

- 計測とレポートは**常に動いている**（`pnpm test:coverage`、CI でも実行してアーティファクト化）
- 閾値だけが未設定。`vitest.config.ts` の `coverage.thresholds` がコメントアウトされている
- CI の `Coverage` ステップも同様

**有効化のタイミング**: 上記「完了条件」の 1〜4 を満たした時点で、
`vitest.config.ts` と `.github/workflows/ci.yaml` の**両方**を同時に更新する。

```typescript
thresholds: { branches: 99, functions: 99, lines: 99, statements: 99 },
```

## 6. テストの書き方の規約

### `@effect/vitest` の `it.effect` を使う

```typescript
it.effect('name', () => Effect.gen(function* () { ... }).pipe(Effect.provide(SomeLayer)))
```

副作用の無い純粋な assertion には `Effect.sync(() => { ... })` を使う
（`Effect.gen` で `yield*` しないと oxlint の `require-yield` が警告する）。

### 例外: DOM イベントフローのテスト

plan.md §3.13 が記録している既知の落とし穴:

> DOM イベントフローのテストで `Effect.fork` + `Deferred.await` を `it.effect` で書くとデッドロックする
> — プレーン `it` + `Effect.runPromise` を使う

mc-save は DOM を持たないので現状は無関係だが、
IndexedDB アダプタのテストで発生しうる。頭の隅に置いておくこと。

### 回帰テストには「なぜ」を書く

参照実装のバグを固定するテストには、
**どのファイルの何行目の挙動を固定しているのか**をコメントに残すこと。
根拠を失ったテストは、次のリファクタで「よく分からないので消す」対象になる。

このリポジトリの既存テストは全てこの形式で書かれている。
