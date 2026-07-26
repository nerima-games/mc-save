/**
 * The save-format registry (plan.md §3.5).
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * A registry rather than a bag of imports because of what it makes possible:
 * enumerating every format a build knows about. That is what lets a "world
 * inspector" or a migration dry-run exist at all, and it is what the reference
 * implementation could not do — its two persisted shapes were reachable only
 * through the four hard-coded methods of the storage service.
 *
 * The registry is an immutable value, not a mutable singleton. Registration
 * returns a new registry or an error; it never mutates in place and never
 * silently overwrites. The reference's presentation layer shows what mutable
 * module-level registries cost: `packages/presentation/hud/sound-captions.ts`
 * keeps `captionsEnabled` and `activeRows` as file-level `let`/`const`, and its
 * tests have to reset global state between cases.
 */
import { Either, Option } from 'effect'
import { DuplicateFormatError } from './errors'
import type { SaveFormat } from './format'

/**
 * A format whose type parameters have been erased.
 *
 * `any` is load-bearing here rather than lazy: a registry holds formats of
 * mutually unrelated types, and `SaveFormat<unknown, unknown>` would not accept
 * a `SaveFormat<Chunk, ChunkEncoded>` because `Schema.Schema` is invariant in
 * both parameters. Callers recover the real type by holding onto the
 * `SaveFormat` value they defined; the registry is for enumeration and
 * name/version lookup, not for typed decoding.
 */
export type AnySaveFormat = SaveFormat<any, any>

export type FormatRegistry = ReadonlyMap<string, AnySaveFormat>

export const emptyRegistry: FormatRegistry = new Map()

export const registerFormat = (
  registry: FormatRegistry,
  format: AnySaveFormat,
): Either.Either<FormatRegistry, DuplicateFormatError> => {
  if (registry.has(format.name)) {
    return Either.left(new DuplicateFormatError({ format: format.name }))
  }
  const next = new Map(registry)
  next.set(format.name, format)
  return Either.right(next)
}

/** Register many at once, stopping at the first duplicate. */
export const registerFormats = (
  registry: FormatRegistry,
  formats: ReadonlyArray<AnySaveFormat>,
): Either.Either<FormatRegistry, DuplicateFormatError> =>
  formats.reduce<Either.Either<FormatRegistry, DuplicateFormatError>>(
    (accumulated, format) => Either.flatMap(accumulated, (current) => registerFormat(current, format)),
    Either.right(registry),
  )

export const lookupFormat = (registry: FormatRegistry, name: string): Option.Option<AnySaveFormat> =>
  Option.fromNullable(registry.get(name))

/**
 * Every registered format's name and current version.
 *
 * Sorted by name so that the output is stable enough to snapshot — a diff in
 * this listing is exactly the review signal that a save format changed, which
 * is the save-file equivalent of the API lock file plan.md §6 Step 0 asks for.
 */
export const describeRegistry = (
  registry: FormatRegistry,
): ReadonlyArray<{ readonly name: string; readonly version: number }> =>
  [...registry.values()]
    .map((format) => ({ name: format.name, version: format.version }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
