---
'@nerima-games/mc-save': patch
---

`docs/versioning.md` が release 工程を誤って説明していたので直しました。版上げ PR は人手が `pnpm changeset version` を実行して作るもので、`.github/workflows/release.yaml` が自動で出すものではありません。release.yaml がやるのは版上げ PR が `main` に merge された後の detect、publish、tag だけです。`CHANGELOG.md` は repository 内では更新されますが `package.json` の `files` に含まれないため配布物に同梱されません。
