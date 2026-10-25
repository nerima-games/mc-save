---
"@nerima-games/mc-save": minor
---

Migrate codec and persistence APIs to Effect 4, adopt mc-kernel 0.9 brands, and add preflighted save-slice migration. This breaking minor changes public call signatures and exported type fields; the exhaustive base-to-head declaration diff and brand construction paths are documented in `docs/api-migration-0.6.0.md` and `docs/migration.md`.
