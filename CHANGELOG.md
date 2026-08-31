# @nerima-games/mc-save

## 0.4.0

### Minor Changes

- [#20](https://github.com/nerima-games/mc-save/pull/20) [`eefd941`](https://github.com/nerima-games/mc-save/commit/eefd94198691f62a7737e19282af2f615216052b) Thanks [@takeokunn](https://github.com/takeokunn)! - Add `undefinedFieldsAsNull`, `restoreNullAsUndefined`, and `encodeUndefinedAsNull` — a reusable
  per-field `undefined` \<-\> `null` codec for `Schema.transform`-based formats. Multiple consumers
  have hand-rolled this pattern to satisfy the integrity checksum's rejection of a bare `undefined`
  anywhere in an encoded payload; this lowers the narrow, per-field swap into the format layer that
  requires it.

### Patch Changes

- [#19](https://github.com/nerima-games/mc-save/pull/19) [`efc2c38`](https://github.com/nerima-games/mc-save/commit/efc2c38c62050bb5388676bd8f7f759d8197f22e) Thanks [@takeokunn](https://github.com/takeokunn)! - Complete the org toolchain devDependency pin set: knip 6.33.0 (its verify gate arrives in Wave 3; the pin belongs to the Wave 0 table) plus @effect/vitest 0.30.0 where it was missing.

## 0.3.0

### Minor Changes

- [#8](https://github.com/nerima-games/mc-save/pull/8) [`bee1a52`](https://github.com/nerima-games/mc-save/commit/bee1a522c38e2e00cec78d43ef38d9b3be003174) Thanks [@takeokunn](https://github.com/takeokunn)! - Integrate durable save work and org-standard migration rescued from the unpushed local main (Phase 0 inventory 2026-08-08).

### Patch Changes

- [#17](https://github.com/nerima-games/mc-save/pull/17) [`4635acc`](https://github.com/nerima-games/mc-save/commit/4635accd26461798f167698b49a6551a6a22a023) Thanks [@takeokunn](https://github.com/takeokunn)! - Toolchain frozen to org pin set (TypeScript 7.0.2, vitest 4.1.11, effect 3.22.1, node 24, pnpm 11.24.0); build switched to tsc emit; release workflow added
