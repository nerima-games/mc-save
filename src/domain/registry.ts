/**
 * The save-format registry.
 *
 * A registry rather than a bag of imports because of what it makes possible:
 * enumerating every format a build knows about. That is what lets a world
 * inspector describe its accepted save contracts, and it is what the reference
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
import { DuplicateFormatError } from './errors.js'

/**
 * The type-erased view of a format held by a heterogeneous registry.
 *
 * A registry holds formats for mutually unrelated payload types. The registry
 * therefore exposes only metadata and an opaque schema; callers retain the
 * typed `SaveFormat` value they defined when they need to encode or decode.
 */
export type RegisteredSaveFormat = {
  readonly name: string
  readonly version: number
  readonly schema: unknown
}

export type FormatRegistry = ReadonlyMap<string, RegisteredSaveFormat>

export const emptyRegistry: FormatRegistry = new Map()

export const registerFormat = (
  registry: FormatRegistry,
  format: RegisteredSaveFormat,
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
  formats: ReadonlyArray<RegisteredSaveFormat>,
): Either.Either<FormatRegistry, DuplicateFormatError> =>
  formats.reduce<Either.Either<FormatRegistry, DuplicateFormatError>>(
    (accumulated, format) => Either.flatMap(accumulated, (current) => registerFormat(current, format)),
    Either.right(registry),
  )

export const lookupFormat = (registry: FormatRegistry, name: string): Option.Option<RegisteredSaveFormat> =>
  Option.fromNullable(registry.get(name))

/**
 * Every registered format's name and current version.
 *
 * Sorted by name so that the output is stable enough to snapshot — a diff in
 * this listing is exactly the review signal that a save format changed.
 */
export const describeRegistry = (
  registry: FormatRegistry,
): ReadonlyArray<{ readonly name: string; readonly version: number }> =>
  [...registry.values()]
    .map((format) => ({ name: format.name, version: format.version }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
