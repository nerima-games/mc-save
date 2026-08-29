---
---

Migrate repository layout, tooling and CI to the nerima-games org standard
(`src/` restructure, retire `api-lock` and `check-dependency-whitelist` in
favour of `.oxlintrc.json`'s `no-restricted-imports`, pin GitHub Actions to
commit SHAs, add Dependabot, enable the 100% coverage gate, adopt changesets).
This changeset records the repository/tooling migration; the public API and
runtime changes are recorded by the versioned changesets for those features.
