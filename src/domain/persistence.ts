/**
 * The two operations a caller actually wants: put a value away, get it back.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * `saveTo` and `loadFrom` are the only place in mc-save where the codec and the
 * medium meet. Keeping the join here — rather than inside `StoragePort`, as the
 * reference implementation did with its `saveChunk`/`loadChunk` pair
 * (`packages/world/infrastructure/storage-service.ts:96-117`) — is what lets a
 * new kind of saved thing be added without touching a single line of adapter
 * code.
 */
import { Effect, Option, Schema } from 'effect'
import { SaveEnvelopeSchema } from './envelope'
import { MigrationError, SaveDecodeError, StorageError } from './errors'
import { decodeSave, encodeSave, type SaveFormat } from './format'
import { StoragePort, type SaveKey } from './storage-port'

/** Encode `value` with `format` and write it under `key`. */
export const saveTo = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  value: A,
): Effect.Effect<void, StorageError | SaveDecodeError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const envelope = yield* encodeSave(format, value)
    yield* storage.put(key, envelope)
  })

/**
 * Read `key`, migrate it up to `format`'s current version, and decode it.
 *
 * Returns `Option.none()` when the key is absent — a missing save is not an
 * error, it is a new world. Everything else is.
 *
 * Note that the envelope is re-validated before it is opened, even though
 * `StoragePort` is typed as returning one. The bytes came from outside this
 * process, and a type annotation is not a runtime guarantee. The reference
 * implementation's habit of trusting stored structure without decoding it
 * (`storage-service.ts:111-115` — a raw `db.get` wrapped in
 * `Option.fromNullable`, no Schema, unlike the metadata path) is precisely how
 * a wrong-sized buffer reached `chunk-manager-ops-storage.ts:47-50`, by which
 * point the only remaining option was to discard the player's chunk and
 * regenerate it.
 */
export const loadFrom = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
): Effect.Effect<Option.Option<A>, StorageError | SaveDecodeError | MigrationError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const stored = yield* storage.get(key)

    if (Option.isNone(stored)) {
      return Option.none<A>()
    }

    const envelope = yield* Schema.decodeUnknown(SaveEnvelopeSchema)(stored.value).pipe(
      Effect.mapError(
        (cause) =>
          new SaveDecodeError({
            format: format.name,
            version: 0,
            reason: `the stored value at "${key}" is not a well-formed save envelope`,
            cause,
          }),
      ),
    )

    return Option.some(yield* decodeSave(format, envelope))
  })
