---
---

Provide oxlint via the Nix devShell (flake.nix) instead of a package.json
devDependency, so the whole org resolves to one pinned oxlint version instead
of each repo drifting independently (some repos were stuck on oxlint 0.12.x,
which never implemented `no-restricted-imports`). CI now installs Nix and runs
lint through `nix develop --command pnpm lint`. No change to the published
package's public API or behaviour — empty changeset, no version bump.
