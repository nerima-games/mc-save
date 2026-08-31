---
"@nerima-games/mc-save": patch
---

Pin `@nerima-games/mc-kernel` to `0.7.0` (from `0.4.0`), matching the org's exact-pin policy. The coordinate and identifier primitives this package consumes (`WorldId`, `ChunkAxis`, `ChunkCoord`, `chunkCoord`, `CHUNK_SIZE_XZ`) are unchanged in behavior across the four kernel releases in between; no save-format bytes or checksum inputs are affected.
