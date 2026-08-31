---
"@nerima-games/mc-save": minor
---

Add `undefinedFieldsAsNull`, `restoreNullAsUndefined`, and `encodeUndefinedAsNull` — a reusable
per-field `undefined` \<-\> `null` codec for `Schema.transform`-based formats. Multiple consumers
have hand-rolled this pattern to satisfy the integrity checksum's rejection of a bare `undefined`
anywhere in an encoded payload; this lowers the narrow, per-field swap into the format layer that
requires it.
