# テストと完了条件

## 1. コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json`（出荷ソース）と `tsconfig.test.json`（テスト+ツール）の両方 |
| `pnpm lint` | oxlint。このリポジトリ唯一の lint/format 設定（prettier も biome も .editorconfig も置かない）。package.json の devDependency ではなく flake.nix の devShell が提供する（org 全体で単一バージョンに固定するため。CI では `nix develop --command pnpm lint` として実行する）。**`--deny-warnings` 付きで走る**ため、`warn` のルールもビルドを落とす（`.oxlintrc.json` は `correctness`/`suspicious`/`perf` の3カテゴリを丸ごと `warn` にし、`style`/`restriction` は個別に選んだルールだけを `warn` にしている(合計87ルールが `warn`)。`error` は2つだけ。このフラグが無かった頃は実質その2つしかゲートになっていなかった）。`@nerima-games/*` の依存境界も `no-restricted-imports` としてここに含まれる（[DEPENDENCY_POLICY.md](https://github.com/nerima-games/.github/blob/main/DEPENDENCY_POLICY.md) §5） |
| `pnpm test` | vitest（`@effect/vitest` の `it.effect` が主 API） |
| `pnpm test:coverage` | カバレッジ計測 + 99% 閾値ゲート（後述）。`verify` には含めない |
| `pnpm verify` | `typecheck && lint && test` の 3 段。CI と同一内容（[TEST_STANDARD.md](https://github.com/nerima-games/.github/blob/main/TEST_STANDARD.md) §1） |

旧・`pnpm check:deps`（依存ホワイトリスト + 循環検査 + `Date.now()` 禁止、
`scripts/check-dependency-whitelist.ts`）は org 標準により廃止された。依存境界の実効は
`.oxlintrc.json` の `no-restricted-imports` に一本化されている。`Date.now()` 等の
raw clock read 禁止は、oxlint がそれを表現できるルールを実装するまでの間、
自動強制を持たない（`.oxlintrc.json` 冒頭のコメント参照）。

`pnpm` は PATH に無い場合がある。`corepack pnpm <cmd>` で 9.15.0 が起動する。

## 2. 現状のテスト

`test/dependency-policy.test.ts`（旧・`scripts/check-dependency-whitelist.ts` の単体テスト）と
`test/api-lock.test.ts`（旧・`scripts/api-lock.ts` の単体テスト）は、それぞれが検証対象としていた
スクリプトの廃止に伴い削除した。現状の6ファイル・70 tests:

```
test/format-roundtrip.test.ts       12 tests   コーデックのラウンドトリップ、連鎖検証
test/migration.test.ts               8 tests   マイグレーション（リネームを含む）、Port 経由のロード
test/storage-port.test.ts            8 tests   StoragePort の契約テスト（インメモリ）
test/binary-roundtrip.test.ts        5 tests   バイナリペイロードのラウンドトリップ
test/legacy-save-compat.test.ts     10 tests   旧セーブ fixture との互換性（§3）
test/indexeddb-storage.test.ts      27 tests   IndexedDB アダプタ + 契約テスト（fake 経由）
                                    ─────
                                     70 tests   全て green
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
参照実装にはバージョン管理そのものが無く（[envelope.ts](../src/domain/envelope.ts) の冒頭:
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
5. カバレッジ 99% ゲートが有効化されている（済。ただし実測が閾値未達 — 後述）

プレビューは無い。UI を持たないリポジトリだからである
（plan.md §2.3-4 の「プレビューは検証対象と同居する」の対象外）。

## 5. カバレッジ閾値: 99% ゲート、有効化済み

組織としての決定（[TEST_STANDARD.md §3](https://github.com/nerima-games/.github/blob/main/TEST_STANDARD.md#3-カバレッジゲート-4-指標-99即日全リポジトリ必須段階移行なし)）
により、段階的ロールアウトを設けず branches / functions / lines / statements の
99% を即時・一律に有効化した。`vitest.config.ts` の `coverage.thresholds` および
CI の `Coverage` ステップは、もはやコメントアウトされていない。

**有効化した時点(2026-08-01)の実測値は 99% を満たしていない**
（`pnpm test:coverage` の実際の出力。`src/domain/indexeddb-surface.ts` 除外後の数値）:

```
All files          |   85.76 |     90.9 |   88.67 |   85.76 |
 src               |       0 |      100 |     100 |       0 |   ← src/index.ts（バレルが直接importされるテストが無い）
 src/domain        |    87.1 |    90.84 |   88.46 |    87.1 |
  registry.ts       |       0 |      100 |     100 |       0 |   ← どのテストからも一切呼ばれていない
  errors.ts         |   92.59 |       75 |      75 |   92.59 |
  format.ts         |   89.06 |     90.9 |     100 |   89.06 |
  indexeddb-storage.ts | 90.98 | 88.88  |   90.32 |   90.98 |
```

（`src/domain/indexeddb-surface.ts` は型宣言のみで実行可能な文が無いため
`coverage.exclude` に加えてある。§ `vitest.config.ts` のコメント参照。）

したがって**このゲートを有効化した直後、CI の `Coverage` ステップは赤くなる**。
これは既知・受容済みの結果として扱う（TEST_STANDARD.md §3 の方針どおり、
延期やしきい値緩和は行わない）。実装側で埋めるべき具体的なギャップ:

- `src/index.ts`: 現在どのテストもバレル経由で import していないため、公開エントリポイント
  としての re-export が一度も実行されない。バレル経由の import を使うテスト（または
  スモークテスト）を追加する
- `src/domain/registry.ts`: `registerFormat` / `registerFormats` / `lookupFormat` /
  `describeRegistry` / `emptyRegistry` を検証するテストが 1 つも無い。`test/registry.test.ts`
  を新設する
- `src/domain/errors.ts` / `format.ts` / `indexeddb-storage.ts`: 既存テストが到達していない
  分岐が残っている。§3 の指針どおり、まず「その分岐は本当に到達可能か」を問うこと

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
