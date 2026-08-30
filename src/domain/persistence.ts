/**
 * The single-value operations a caller actually wants: put a value away, get
 * it back.
 *
 * `saveTo`, `loadFrom`, and `saveBatch` are the places in mc-save where the
 * codec and the medium meet. Keeping the join here, rather than inside
 * `StoragePort`, lets a new kind of saved thing be added without touching the
 * adapter code.
 */
import { Effect, Option, Schema } from 'effect'
import { SaveEnvelopeSchema } from './envelope.js'
import { SaveDecodeError, StorageError } from './errors.js'
import { decodeSave, type SaveFormat } from './format.js'
import { isDurablePreviousKey } from './durable-key.js'
import { DEFAULT_MAX_SAVE_BYTES, validateSaveEnvelope } from './integrity.js'
import { prepareSave, type SaveWriteOptions } from './save-preparation.js'
import type { SaveKey } from './save-key.js'
import { StoragePort } from './storage-port.js'

export type { SaveWriteOptions } from './save-preparation.js'

export type ListedSave<A> = {
  readonly key: SaveKey
  readonly value: A
}

export type ListedSaveFailure =
  | {
      readonly _tag: 'SaveDecodeError'
      readonly key: SaveKey
      readonly format: string
      readonly version: number
      readonly reason: string
    }

export type SaveListing<A> = {
  readonly valid: ReadonlyArray<ListedSave<A>>
  readonly corrupt: ReadonlyArray<ListedSaveFailure>
}

export type SaveReadOptions = {
  readonly maxBytes?: number
}

/** Encode `value` with `format` and write it under `key`. */
export const saveTo = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  value: A,
  options?: SaveWriteOptions,
): Effect.Effect<void, StorageError | SaveDecodeError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const envelope = yield* prepareSave(format, value, options)
    yield* storage.put(key, envelope)
  })

/**
 * Read `key`, require `format`'s current version, and decode it.
 *
 * Returns `Option.none()` when the key is absent — a missing save is not an
 * error, it is a new world. Everything else is.
 *
 * Note that the envelope is re-validated before it is opened, even though
 * `StoragePort` is typed as returning one. The bytes came from outside this
 * process, and a type annotation is not a runtime guarantee.
 */
export const loadFrom = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  options?: SaveReadOptions,
): Effect.Effect<Option.Option<A>, StorageError | SaveDecodeError, StoragePort> =>
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

    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_SAVE_BYTES
    const validated = yield* validateSaveEnvelope(envelope, maxBytes)
    return Option.some(yield* decodeSave(format, validated))
  })

/**
 * Decode every stored record without allowing one bad save to hide the rest.
 *
 * Record-level decode errors are returned as data. Storage
 * failures still fail the Effect because no complete listing can be claimed
 * when the medium itself could not be read. Failure entries intentionally omit
 * the underlying cause, which may contain the stored payload.
 */
export const listFrom = <A, I>(
  format: SaveFormat<A, I>,
  options?: SaveReadOptions,
): Effect.Effect<SaveListing<A>, StorageError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const keys = (yield* storage.keys).filter((key) => !isDurablePreviousKey(key))
    const valid: Array<ListedSave<A>> = []
    const corrupt: Array<ListedSaveFailure> = []

    yield* Effect.forEach(
      keys,
      (key) =>
        loadFrom(format, key, options).pipe(
          Effect.catchTags({
            SaveDecodeError: (error) =>
              Effect.sync(() => {
                corrupt.push({
                  _tag: error._tag,
                  key,
                  format: error.format,
                  version: error.version,
                  reason: error.reason,
                })
                return Option.none<A>()
              }),
          }),
          Effect.map((value) => {
            if (Option.isSome(value)) {
              valid.push({ key, value: value.value })
            }
          }),
        ),
      { concurrency: 1, discard: true },
    )

    return { valid, corrupt }
  })
