/**
 * `defineFormat` — the toolkit plan.md §3.5 asks mc-save to provide.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * ---------------------------------------------------------------------------
 * This is net-new, not a port
 * ---------------------------------------------------------------------------
 *
 * The reference implementation has no migration engine. `grep -rn
 * "MigrationManager\|MigrationError"` over its `packages/`, `src/` and `e2e/`
 * returns nothing; the design sketch at
 * `docs/reference/game-systems/save-file-format.md:644-690` was never built.
 * Backwards compatibility was achieved entirely by marking every new field
 * `Schema.optional`, which the source says out loud — e.g.
 * `packages/world/domain/world-metadata-model.ts:114-117` ("Plain optional so
 * pre-vehicle saves decode to undefined") and
 * `packages/core/domain/inventory-save-data.ts:15` ("Anvil rename — optional
 * keeps pre-rename saves decodable").
 *
 * That technique works and should keep working, but it is one-way: it can add a
 * field, never rename, re-shape, or re-interpret one. When the reference needed
 * a real change it resorted to ad-hoc repair code at the call site —
 * `healHollowWaterBeds(...)` in
 * `packages/world/application/chunk-manager-ops-storage.ts:54-60`, commented
 * "Repair chunks saved before the carver fix (hollow river/lake beds)". That is
 * a migration; it is simply a migration with no name, no version number, no
 * test, and no way to know when it can be deleted.
 *
 * `defineFormat` exists so that the next one of those is a numbered step in a
 * chain instead.
 */
import { Effect, Schema } from 'effect'
import { MigrationError, SaveDecodeError } from './errors'
import { FIRST_VERSION, isFromFuture, saveEnvelope, type SaveEnvelope } from './envelope'

/**
 * One step of a migration chain: `from` → `from + 1`.
 *
 * Steps are deliberately single-version rather than arbitrary `from`/`to` pairs.
 * A chain of N-1 single steps is O(N) to write and O(N) to test; a graph of
 * arbitrary jumps is O(N²) and, in practice, is the shape in which the rarely
 * travelled edges rot undetected.
 */
export type Migration = {
  readonly from: number
  /** Human-readable, and used in `MigrationError.reason`. Say what changed and why. */
  readonly describe: string
  /**
   * Transform a v`from` payload into a v`from + 1` payload.
   *
   * The failure channel is a plain message, not a `MigrationError`: a step
   * knows *what* went wrong but not which format it belongs to or which
   * version pair it sits between. `migrateToCurrent` owns that context and
   * fills it in, so a step cannot mislabel itself.
   */
  readonly migrate: (payload: unknown) => Effect.Effect<unknown, string>
}

export type SaveFormat<A, I = A> = {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Schema<A, I>
  readonly migrations: ReadonlyArray<Migration>
}

/**
 * Problems with a format definition, as a list of human-readable strings.
 *
 * Split out from `defineFormat` so that the rules can be unit-tested directly
 * rather than through `expect(() => ...).toThrow()`, which can only ever assert
 * that *something* was wrong.
 */
export const validateMigrationChain = (spec: {
  readonly name: string
  readonly version: number
  readonly migrations: ReadonlyArray<Migration>
}): ReadonlyArray<string> => {
  const problems: Array<string> = []

  if (!Number.isInteger(spec.version) || spec.version < FIRST_VERSION) {
    problems.push(`version must be an integer >= ${String(FIRST_VERSION)}, received ${String(spec.version)}`)
    return problems
  }

  const required = spec.version - FIRST_VERSION
  const seen = new Set<number>()

  for (const migration of spec.migrations) {
    if (!Number.isInteger(migration.from) || migration.from < FIRST_VERSION) {
      problems.push(`migration.from must be an integer >= ${String(FIRST_VERSION)}, received ${String(migration.from)}`)
      continue
    }
    if (migration.from >= spec.version) {
      problems.push(
        `migration ${String(migration.from)} → ${String(migration.from + 1)} would produce a version above the ` +
          `current version ${String(spec.version)}; bump the format version or delete the step`,
      )
      continue
    }
    if (seen.has(migration.from)) {
      problems.push(`two migrations both start at version ${String(migration.from)}; a chain must be linear`)
      continue
    }
    seen.add(migration.from)
  }

  for (let version = FIRST_VERSION; version < spec.version; version += 1) {
    if (!seen.has(version)) {
      problems.push(
        `no migration from version ${String(version)} to ${String(version + 1)}; every version this format has ` +
          'ever had must have a way forward, or saves written by that build become unreadable',
      )
    }
  }

  if (spec.migrations.length > 0 && required === 0) {
    problems.push(`version is ${String(FIRST_VERSION)} but ${String(spec.migrations.length)} migration(s) are declared`)
  }

  return problems
}

/**
 * Define a save format.
 *
 * Throws on an incomplete migration chain, and does so at module-evaluation
 * time rather than when a player with an old save happens to load it. A gap in
 * the chain is not a runtime condition to be handled — it is a build that must
 * not ship. Use `validateMigrationChain` if you want the problems as data.
 */
export const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Schema<A, I>
  readonly migrations?: ReadonlyArray<Migration>
}): SaveFormat<A, I> => {
  const migrations = spec.migrations ?? []
  const problems = validateMigrationChain({ name: spec.name, version: spec.version, migrations })

  if (problems.length > 0) {
    throw new Error(`save format "${spec.name}" is not well-formed:\n${problems
      .map((problem) => `  - ${problem}`)
      .join('\n')}`)
  }

  return {
    name: spec.name,
    version: spec.version,
    schema: spec.schema,
    migrations: [...migrations].sort((left, right) => left.from - right.from),
  }
}

/** Encode a value into an envelope stamped with the format's current version. */
export const encodeSave = <A, I>(
  format: SaveFormat<A, I>,
  value: A,
): Effect.Effect<SaveEnvelope, SaveDecodeError> =>
  Schema.encode(format.schema)(value).pipe(
    Effect.map((encoded) => saveEnvelope(format.name, format.version, encoded)),
    Effect.mapError(
      (cause) =>
        new SaveDecodeError({
          format: format.name,
          version: format.version,
          reason: 'the value does not satisfy the format schema, so it cannot be encoded',
          cause,
        }),
    ),
  )

/**
 * Run the migration chain from `envelope.version` up to `format.version`.
 *
 * Exported separately from `decodeSave` because a migration chain is worth
 * testing on its own: you want to assert the *shape* each step produces, not
 * only that the final schema accepted the end result.
 */
export const migrateToCurrent = <A, I>(
  format: SaveFormat<A, I>,
  envelope: SaveEnvelope,
): Effect.Effect<unknown, MigrationError> => {
  const steps = format.migrations.filter((migration) => migration.from >= envelope.version)

  return Effect.reduce(steps, envelope.payload, (payload, migration) =>
    migration.migrate(payload).pipe(
      Effect.mapError(
        (reason) =>
          new MigrationError({
            format: format.name,
            fromVersion: migration.from,
            toVersion: migration.from + 1,
            reason: `${migration.describe} — ${reason}`,
          }),
      ),
    ),
  )
}

/**
 * Open an envelope: reject foreign and future saves, migrate, then decode.
 *
 * The ordering is the whole point. Migration happens on the raw payload, before
 * `Schema` is applied, so a migration is free to see a shape that no current
 * schema can describe. Decoding first — which is what "just add
 * `Schema.optional`" amounts to — restricts every future change to those that
 * the *current* schema can already parse.
 */
export const decodeSave = <A, I>(
  format: SaveFormat<A, I>,
  envelope: SaveEnvelope,
): Effect.Effect<A, SaveDecodeError | MigrationError> =>
  Effect.gen(function* () {
    if (envelope.format !== format.name) {
      return yield* new SaveDecodeError({
        format: format.name,
        version: envelope.version,
        reason: `envelope belongs to format "${envelope.format}", not "${format.name}"`,
      })
    }

    if (isFromFuture(envelope, format.version)) {
      return yield* new SaveDecodeError({
        format: format.name,
        version: envelope.version,
        reason:
          `this save was written by a newer build (v${String(envelope.version)} > v${String(format.version)}). ` +
          'It is not corrupt and must not be offered for deletion — it needs a newer version of the game.',
      })
    }

    const migrated = yield* migrateToCurrent(format, envelope)

    return yield* Schema.decodeUnknown(format.schema)(migrated).pipe(
      Effect.mapError(
        (cause) =>
          new SaveDecodeError({
            format: format.name,
            version: envelope.version,
            reason:
              envelope.version === format.version
                ? 'the payload does not satisfy the current schema'
                : `the payload does not satisfy the current schema after migrating v${String(envelope.version)} → ` +
                  `v${String(format.version)}; the migration chain is probably wrong`,
            cause,
          }),
      ),
    )
  })
