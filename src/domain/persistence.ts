/**
 * The single-value operations a caller actually wants: put a value away, get
 * it back.
 *
 * `saveTo`, `loadFrom`, and `saveBatch` are the places in mc-save where the
 * codec and the medium meet. Keeping the join here, rather than inside
 * `StoragePort`, lets a new kind of saved thing be added without touching the
 * adapter code.
 */
import { Effect, Option, Result, Schema } from 'effect'
import {
  SaveErrorFormatLabel,
  SaveErrorVersion,
  ValidationMessage,
  type SaveErrorFormatLabel as SaveErrorFormatLabelType,
  type SaveErrorVersion as SaveErrorVersionType,
  type SaveMaxBytes,
} from './brand-types.js'
import { SaveEnvelopeSchema } from './envelope.js'
import { SaveDecodeError, StorageError } from './errors.js'
import { decodeSave, type SaveFormat } from './format.js'
import { isDurablePreviousKey } from './durable-key.js'
import { resolveSaveMaxBytes, validateSaveEnvelope } from './integrity.js'
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
      readonly format: SaveErrorFormatLabelType
      readonly version: SaveErrorVersionType
      readonly reason: ValidationMessage
    }

export type SaveListing<A> = {
  readonly valid: ReadonlyArray<ListedSave<A>>
  readonly corrupt: ReadonlyArray<ListedSaveFailure>
}

export type SaveReadOptions = {
  readonly maxBytes?: SaveMaxBytes
}

const resolveReadMaxBytes = <A, I>(
  format: SaveFormat<A, I>,
  options?: SaveReadOptions,
): Effect.Effect<SaveMaxBytes, SaveDecodeError> =>
  Effect.gen(function* () {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return yield* Effect.fail(new SaveDecodeError({
        format: format.name,
        version: format.version,
        reason: 'save read options could not be read',
        cause: new TypeError('options must be an object'),
      }))
    }
    const maxBytesValue = yield* Effect.try({
      try: () => options === undefined ? undefined : Reflect.get(options, 'maxBytes'),
      catch: (cause) => new SaveDecodeError({
        format: format.name,
        version: format.version,
        reason: 'save read options could not be read',
        cause,
      }),
    })
    return yield* Effect.fromResult(resolveSaveMaxBytes(maxBytesValue, format.name, format.version))
  })

const loadFromWithMaxBytes = <A, I>(
  format: SaveFormat<A, I>,
  key: SaveKey,
  maxBytes: SaveMaxBytes,
): Effect.Effect<Option.Option<A>, StorageError | SaveDecodeError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const stored = yield* storage.get(key)
    if (!Option.isOption(stored)) {
      return yield* Effect.fail(
        new StorageError({ operation: 'persistence.get', key, cause: 'storage returned an invalid option' }),
      )
    }

    if (Option.isNone(stored)) {
      return Option.none<A>()
    }

    const envelope = yield* Effect.try({
      try: () => Schema.decodeUnknownResult(SaveEnvelopeSchema)(stored.value),
      catch: (cause) =>
        new SaveDecodeError({
          format: format.name,
          version: 0,
          reason: `the stored value at "${key}" could not be read as a save envelope`,
          cause,
        }),
    }).pipe(
      Effect.flatMap((decoded) =>
        Result.isFailure(decoded)
          ? Effect.fail(
              new SaveDecodeError({
                format: format.name,
                version: 0,
                reason: `the stored value at "${key}" is not a well-formed save envelope`,
                cause: decoded.failure,
              }),
            )
          : Effect.succeed(decoded.success),
      ),
    )

    const validated = yield* validateSaveEnvelope(envelope, maxBytes)
    return Option.some(yield* decodeSave(format, validated))
  })

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
    const maxBytes = yield* resolveReadMaxBytes(format, options)
    return yield* loadFromWithMaxBytes(format, key, maxBytes)
  })

/**
 * Decode every stored record without allowing one bad save to hide the rest.
 *
 * Record-level decode errors are returned as data. Read-option and storage
 * failures still fail the Effect because the requested listing could not be
 * completed. Failure entries intentionally omit the underlying cause, which may
 * contain the stored payload.
 */
export const listFrom = <A, I>(
  format: SaveFormat<A, I>,
  options?: SaveReadOptions,
): Effect.Effect<SaveListing<A>, StorageError | SaveDecodeError, StoragePort> =>
  Effect.gen(function* () {
    const maxBytes = yield* resolveReadMaxBytes(format, options)
    const storage = yield* StoragePort
    const keys = (yield* storage.keys).filter((key) => !isDurablePreviousKey(key))
    const valid: Array<ListedSave<A>> = []
    const corrupt: Array<ListedSaveFailure> = []

    yield* Effect.forEach(
      keys,
      (key) =>
        loadFromWithMaxBytes(format, key, maxBytes).pipe(
          Effect.catchTags({
          SaveDecodeError: (error) => {
            const formatLabel = SaveErrorFormatLabel.result(error.format)
            const version = SaveErrorVersion.result(error.version)
            const reason = ValidationMessage.result(error.reason)
            if (Result.isFailure(formatLabel) || Result.isFailure(version) || Result.isFailure(reason)) {
              return Effect.fail(
                new StorageError({ operation: 'persistence.listFrom', key, cause: 'save decode error fields are malformed' }),
              )
            }
            return Effect.sync(() => {
                corrupt.push({
                  _tag: error._tag,
                  key,
                  format: formatLabel.success,
                  version: version.success,
                  reason: reason.success,
                })
                return Option.none<A>()
            })
          },
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
