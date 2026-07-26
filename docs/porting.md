# 移植元

参照実装: `takeokunn/ts-minecraft`（凍結。仕様書 + テストオラクルとして扱う）。

**LOC は全て `wc -l` の実測値である。plan.md の見積もりは信用しないこと。**

---

<a id="loc"></a>
## 0. plan.md §3.5 の LOC 表記について

> plan.md §3.5 移植元:
> `packages/world/infrastructure` の storage-service.ts / storage-idb-model.ts /
> storage-serialization.ts（**535 LOC**）+ save fixtures

数え方が混ざっている。実測:

```console
$ wc -l packages/world/infrastructure/*.ts
  243 packages/world/infrastructure/idb-utils.ts
   19 packages/world/infrastructure/storage-error-mapping.ts
   28 packages/world/infrastructure/storage-idb-model.ts
   51 packages/world/infrastructure/storage-serialization.ts
  194 packages/world/infrastructure/storage-service.ts
  535 total
```

- **名指しされた 3 ファイルの合計は 273 LOC**（194 + 28 + 51）
- **535 は `infrastructure/` ディレクトリ全 5 ファイルの合計**

535 という数字自体は正しいが、それは 3 ファイルの合計ではない。
そして省略された 2 ファイルのうち `idb-utils.ts` (243 LOC) は
**このディレクトリで最大**であり、IndexedDB アダプタを書くときに最も参照するものである。

さらに `save fixtures` は存在しない → [design-notes.md](./design-notes.md#dn-2)。

---

## 1. 中核（最優先で読む）

| LOC | パス | 役割 |
| ---: | --- | --- |
| 194 | `packages/world/infrastructure/storage-service.ts` | フルサービス。7 メソッド |
| 243 | `packages/world/infrastructure/idb-utils.ts` | IndexedDB の Effect ラッパ。**plan.md §3.5 が漏らしている最大ファイル** |
| 51 | `packages/world/infrastructure/storage-serialization.ts` | メタデータの encode/decode、`{ valid, corrupt }` 分割 |
| 28 | `packages/world/infrastructure/storage-idb-model.ts` | DB 名・バージョン・ストア名・鍵生成 |
| 19 | `packages/world/infrastructure/storage-error-mapping.ts` | `IndexedDBError` → `StorageError`、リトライ/クォータ |
| **535** | **小計** | |

## 2. ドメイン側

| LOC | パス | 役割 |
| ---: | --- | --- |
| 162 | `packages/world/domain/world-metadata-model.ts` | `WorldMetadataSchema`。`Schema.optional` 互換戦略の実例集 |
| 31 | `packages/world/domain/storage-service-port.ts` | アプリ層に露出する狭い Port（2 メソッド）、`ChunkStorageValue` |
| 17 | `packages/world/domain/errors.ts` | 再 export |
| 14 | `packages/block/domain/errors.ts` | **`StorageError` の本当の定義場所** |
| 128 | `packages/world/domain/chunk.ts` | `WORLD_SCHEMA_VERSION`、バイトレイアウト |
| 29 | `packages/block/domain/fluid.ts` | `FLUID_BYTE_LENGTH` |
| **381** | **小計** | |

中核 + ドメイン = **916 LOC**。これが「mc-save が移植対象として見るべき範囲」の実測値である。

## 3. 消費側（移植対象ではないが、Port の形を決めるために読む）

| LOC | パス |
| ---: | --- |
| 63 | `packages/world/application/chunk-manager-ops-storage.ts`（`healHollowWaterBeds` を含む） |
| 54 | `packages/world/application/chunk-manager-cache.ts` |
| 17 | `packages/world/application/chunk-manager-service-save.ts` |
| 14 | `packages/world/application/chunk-manager-service-save-selection.ts` |
| 137 | `packages/app/application/main/layers/infrastructure-bundles.ts`（`StoragePortLayer` の橋渡し） |
| 108 | `packages/app/application/main/session-persist.ts` |
| 229 | `packages/app/application/main/session-world-loader.ts` |
| 126 | `packages/app/application/main/session-world-loader-metadata.ts` |
| 67 | `packages/app/application/main/session-autosave.ts` |
| 58 | `packages/app/application/main/session-autosave-status.ts` |
| 42 | `packages/app/application/main/session-save-metadata.ts` |
| 45 | `packages/app/application/main/session-save-player-state.ts` |
| 55 | `packages/app/application/main/session-restore-saved-player-state.ts` |
| 30 | `packages/app/application/main/browser-runtime-save-effects.ts` |
| 24 | `packages/core/domain/inventory-save-data.ts` |
| 42 / 43 / 13 | `packages/inventory/application/{chest,equipment,furnace}-persistence.ts` |

**これらは mc-save に来ない。** `session-*` は mc-compose、
`chunk-manager-*` は mc-worldgen、`*-persistence.ts` は mc-sim の担当である。
読む目的は「Port がどう使われるか」を知るためだけ。

## 4. もう 1 つの IndexedDB アダプタ（設定用）

| LOC | パス |
| ---: | --- |
| 151 | `packages/game/infrastructure/settings-storage-service.ts` |
| 14 | `packages/game/domain/settings-storage-port.ts` |
| 59 | `packages/game/domain/errors.ts`（`SettingsError`） |

**重要**: これは `idb-utils.ts` を再利用せず、
`requestEffect` / `writeRequestEffect` / `openSettingsDatabase` を手書きで重複実装している。
mc-save の存在意義の一つがこの重複の解消である。

## 5. テスト資産（移植価値順）

| LOC | パス | 移植価値 |
| ---: | --- | --- |
| 304 | `packages/world/test/storage-service.test.ts` | 高。Port 契約テストの下敷き |
| 275 | `packages/world/test/storage-service-schema.test.ts` | 高。互換性ケースの一覧として |
| 215 | `packages/world/test/storage-service-quota.test.ts` | 高。クォータ挙動 |
| 191 | `packages/world/test/idb-utils.test.ts` | 高。IDB アダプタ実装時 |
| 177 | `packages/world/test/storage-service.property.test.ts` | 中。プロパティテスト |
| 124 | `packages/world/test/storage-error-mapping.test.ts` | 中 |
| 107 | `packages/world/test/storage-service-encode-roundtrip.test.ts` | 高 |
| 103 | `packages/world/test/storage-serialization.test.ts` | 中 |
| 189 | `packages/world/test/storage-service-test-utils.ts` | 低。**5 つの重複二重化の 1 つ**。mc-save は 1 本にまとめる |
| 36 | `e2e/contracts/storage-service-contract-runner.ts` | 高。実ブラウザでの契約テスト |
| 108 | `e2e/persistence/save-load.e2e.ts` | 高。E2E は mc-compose へ |
| 174 | `e2e/helpers/db-helpers.ts` | 中 |

## 6. 参照実装のドキュメント

| LOC | パス | 注意 |
| ---: | --- | --- |
| 970 | `docs/reference/game-systems/save-file-format.md` | **構想文書であって実装ではない。** `:644-690` のマイグレーション API は存在しない |

## 7. 移植の進め方

1. **`storage-idb-model.ts` (28) を読む** — 定数を全部持ってくる。5 分で終わる
2. **`storage-service-port.ts` (31) を読む** — Port の狭さの手本
3. **`idb-utils.ts` (243) を読む** — IDB アダプタを書くときの本体
4. **`world-metadata-model.ts` (162) を読む** — `Schema.optional` 互換の限界を体感するため。
   この限界を超えるのが mc-save の `defineFormat` である
5. **fixture は自分で作る** — 移植元が無い

`storage-service.ts` (194) 自体は**そのまま移植しない**。
7 メソッドのうち 4 つはドメイン語彙で特殊化された同じ 2 操作であり、
mc-save ではその特殊化が消える。
