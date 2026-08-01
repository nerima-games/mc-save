---
---

Migrate repository layout, tooling and CI to the nerima-games org standard
(`src/` restructure, retire `api-lock` and `check-dependency-whitelist` in
favour of `oxlint.json`'s `no-restricted-imports`, pin GitHub Actions to
commit SHAs, add Dependabot, enable the 99% coverage gate, adopt changesets).
No change to the published package's public API or behaviour — empty
changeset, no version bump.
