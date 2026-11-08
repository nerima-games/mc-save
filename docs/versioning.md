# Versioning

## Two independent versions

The package version and save format version are separate contracts.

| Version | Meaning | Defined in |
| --- | --- | --- |
| Package version | Published package release | `version` in `package.json` |
| Format version | Current schema generation for one payload | `defineFormat({ version })` |

A format-version change should update the schema, fixtures, and consumer release plan together.

## Current format contract

A format is identified by an exact name and version. `decodeSave` rejects:

- An envelope for a different format
- A future version
- An older version without a complete migration chain to the current format
- An envelope with invalid integrity, byte length, or payload schema

Consumers can define a contiguous chain of migrations for ordinary save formats. Each step decodes its source with that version's schema, then returns the next version's encoded payload; the next step decodes that payload, and the current schema decodes the final result. The consumer owns the version history and conversion logic. Without a complete chain, an older save remains unsupported; that is not evidence of corruption, so preserve it until a suitable migration is available. A successful read does not rewrite the stored envelope; writing the loaded value stores it in the current version.

The save-slice API is a separate migration boundary. It resolves an explicit unique path from one slice version to another and decodes all slices before calling restore callbacks.

`SaveDecodeError` can identify the failed save, head, or chunk record and include repair guidance. Save listings omit error causes and payloads. Revisioned-save consumers can opt into `writeRevisionedSaveWithCheckpoint` to copy a validated previous revision under revision-specific keys before publishing the replacement. The checkpoint head is written after its chunks; an invalid or incomplete live revision does not replace an existing checkpoint. `readRevisionedSave` reports healthy chunks alongside per-chunk decode failures so a consumer can choose a repair policy.

The checkpoint API is generic and does not change the IndexedDB layout version. Consumers supply the checkpoint key namespace and health validation. After cleanup, storage is approximately the live revision plus one retained copy. During replacement, storage can approach four revision sizes when keys do not overlap: the current live revision, old checkpoint, new checkpoint copy, and next live revision being written.

## IndexedDB layout version

The IndexedDB object-store, index, and record-layout version is independent of the save format version. A layout upgrade changes the adapter's storage contract, not a Minecraft payload schema. Envelope format, version, and integrity checks remain in force after a layout upgrade.

## Package releases

Release inputs include `engines`, `packageManager`, the lockfile, exports, and the Changesets entry. Before publishing a change, verify that:

1. Source and declaration exports agree.
2. `pnpm verify`, coverage, browser tests, and `pnpm package:verify` pass.
3. The package version and changeset intent agree.
4. The exact `@nerima-games/mc-kernel` version and lockfile are reproducible for consumers.

`@nerima-games/mc-kernel` is pinned exactly. When updating it, review the matching consumer-migration and public API documentation in the mc-kernel repository, then apply only the changes relevant to the shared types, guards, and constants used by mc-save. If a migration does not change persisted wire values, it does not require a save format version change.

Use `pnpm changeset status` to review the pending release state.

Package version bumps are manual. `pnpm changeset version` updates `package.json` and `CHANGELOG.md`; review that diff in a release pull request. The repository does not create that version-bump pull request automatically.

After a version-bump pull request is merged, `.github/workflows/release.yaml` compares the package version before and after the push to `main`. If it changed, the workflow reruns `pnpm verify` and `pnpm package:verify`, publishes with `pnpm publish --no-git-checks`, then pushes a `v<version>` tag. Pushes that do not change the version, such as documentation-only changes, skip publish and tag jobs. The `workflow_dispatch` retry path bypasses that comparison and publishes the version currently in `package.json` even if it has not changed; before dispatching it, confirm that this is the version intended for publication. `CHANGELOG.md` is maintained in the repository but is not included in the package because it is not listed in `package.json`'s `files`.
