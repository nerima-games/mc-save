---
---

Provide the same `oxlint` command in the Nix devShell as in the package-managed
CI install, so local Nix users do not need a global install. CI continues to
resolve its toolchain from `package.json` and the lockfile. This is a tooling
only change with no published package API or behavior change.
