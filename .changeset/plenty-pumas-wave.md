---
"@nerima-games/mc-save": patch
---

Add `test/migration.test.ts`, the evidence file the feature catalog's `save/versioned-persistence` row declared but the package never had. It documents, against a hand-authored v1 fixture (not produced by any encoder in this package), that `decodeSave` has no automatic upgrade path — it unconditionally refuses any envelope whose version does not match the format's current version — and demonstrates the migration path a consumer has to build for itself from `SaveEnvelopeSchema`, `Schema.decodeUnknown` against an old-version schema, and `encodeSave` under the current format. No source behavior changed.
