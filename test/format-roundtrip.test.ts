import { describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { effect } from './support/effect-test.js'
import { applyUntrustedArgument } from './support/apply-untrusted-argument.js'
import { Effect, Result, Schema } from 'effect'
import { SaveEnvelopeDraftSchema, SaveEnvelopeSchema } from '../src/domain/envelope.js'
import {
  decodeSave,
  defineFormat as defineFormatResult,
  defineFormatMigration as defineFormatMigrationResult,
  encodeSave,
} from '../src/domain/format.js'
import { CanonicalJson } from '../src/domain/brand-types.js'
import { checksumOf, utf8Bytes } from '../src/domain/integrity-canonical.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

/**
 * A format whose encoded form differs from its decoded form, so that a
 * round-trip test can actually fail. A format where `A` and `I` coincide would
 * pass `decode(encode(x)) === x` even if both were the identity.
 */
const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<A, I>
}) => Result.getOrThrow(defineFormatResult(spec))
const PlayerStateSchema = Schema.Struct({
  worldId: Schema.String,
  health: Schema.Number.check(
    Schema.makeFilter<number>((value) => value >= 0 && value <= 20 ? undefined : 'health must be between 0 and 20'),
  ),
  lastPlayed: Schema.DateFromMillis,
})

const PlayerState = defineFormat({
  name: 'mc-save/test/player-state',
  version: 1,
  schema: PlayerStateSchema,
})

const VersionTwoPlayerState = defineFormat({
  name: 'mc-save/test/version-two-player-state',
  version: 2,
  schema: Schema.Struct({ worldId: Schema.String }),
})

describe('encodeSave / decodeSave', () => {
  effect('round-trips a value through its encoded representation', () =>
    Effect.gen(function* () {
      const original = {
        worldId: 'world-1',
        health: 17.5,
        lastPlayed: new Date(1_700_000_000_000),
      }

      const envelope = yield* encodeSave(PlayerState, original)
      const restored = yield* decodeSave(PlayerState, envelope)

      expect(restored).toStrictEqual(original)
    }),
  )

  effect('rejects malformed envelopes at the public decode boundary', () =>
    Effect.gen(function* () {
      const malformedValues: ReadonlyArray<unknown> = [
        null,
        { format: PlayerState.name, version: 0, payload: null },
        { format: PlayerState.name, version: 'not-a-version', payload: null },
      ]

      for (const malformed of malformedValues) {
        const result = yield* Effect.flip(decodeSave(PlayerState, malformed))
        expect(result._tag).toBe('SaveDecodeError')
        if (result._tag === 'SaveDecodeError') {
          expect(result.reason).toBe('the value is not a well-formed save envelope')
        }
      }
    }),
  )

  effect('stamps the envelope with the format name and current version', () =>
    Effect.gen(function* () {
      const envelope = yield* encodeSave(PlayerState, {
        worldId: 'world-1',
        health: 20,
        lastPlayed: new Date(0),
      })

      expect(envelope.format).toBe('mc-save/test/player-state')
      expect(envelope.version).toBe(1)
      // The encoded payload is the *wire* shape: a number, not a Date. Keeping
      // runtime-only objects out of the envelope makes the stored form portable.
      expect(envelope.payload).toStrictEqual({
        worldId: 'world-1',
        health: 20,
        lastPlayed: 0,
      })
    }),
  )

  effect('refuses an envelope belonging to a different format, even when the payload would fit', () =>
    Effect.gen(function* () {
      // The payload here is a perfectly valid PlayerState. Only the name differs,
      // and that alone must be disqualifying — otherwise a key collision between
      // two formats decodes as success.
      const foreign = sealedTestEnvelope('mc-save/test/something-else', 1, {
        worldId: 'w',
        health: 1,
        lastPlayed: 0,
      })
      const result = yield* Effect.flip(decodeSave(PlayerState, foreign))

      expect(result._tag).toBe('SaveDecodeError')
      expect(result.message).toContain('mc-save/test/something-else')
    }),
  )

  /**
   * REGRESSION: a save from a newer build is not corruption.
   *
   * Listing can use this distinction to keep a newer save unavailable without
   * classifying it as corrupt or offering destructive recovery actions.
   */
  effect('reports a save written by a newer build as such, not as corruption', () =>
    Effect.gen(function* () {
      const fromFuture = sealedTestEnvelope('mc-save/test/player-state', 99, { anything: true })
      const result = yield* Effect.flip(decodeSave(PlayerState, fromFuture))

      expect(result._tag).toBe('SaveDecodeError')
      expect(result.message).toContain('newer build')
      expect(result.message).toContain('must not be offered for deletion')
      if (result._tag === 'SaveDecodeError') {
        expect(result.version).toBe(99)
      }
    }),
  )

  effect('reports the recorded version when the payload does not satisfy the schema', () =>
    Effect.gen(function* () {
      const broken = sealedTestEnvelope('mc-save/test/player-state', 1, { worldId: 'w', health: 999, lastPlayed: 0 })
      const result = yield* Effect.flip(decodeSave(PlayerState, broken))

      expect(result._tag).toBe('SaveDecodeError')
      if (result._tag === 'SaveDecodeError') {
        expect(result.version).toBe(1)
        expect(result.reason).toContain('current schema')
      }
    }),
  )

  effect('rejects an older version when no compatibility decoder exists', () =>
    Effect.gen(function* () {
      const previous = sealedTestEnvelope(VersionTwoPlayerState.name, 1, { worldId: 'world-1' })
      const result = yield* Effect.flip(decodeSave(VersionTwoPlayerState, previous))

      expect(result._tag).toBe('SaveDecodeError')
      if (result._tag === 'SaveDecodeError') {
        expect(result.version).toBe(1)
        expect(result.reason).toContain('migration from v1 to v2 is not defined')
      }
    }),
  )

  /**
   * `encodeSave`'s own failure path, distinct from `decodeSave`'s: the value in
   * hand satisfies TypeScript but not the schema's ENCODE direction. A struct
   * whose field encoder can itself fail — as opposed to a struct that simply
   * rejects a wrong-shaped `unknown` on decode — is the only way to reach it.
   */
  const NonNegativeOnEncode = Schema.Number.check(
    Schema.makeFilter<number>((value) => value < 0 ? 'score must not be negative' : undefined),
  )

  const ScoreOnly = defineFormat({
    name: 'mc-save/test/score-only',
    version: 1,
    schema: Schema.Struct({ score: NonNegativeOnEncode }),
  })

  effect('fails encoding, not decoding, when the value cannot satisfy the schema on its way out', () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(encodeSave(ScoreOnly, { score: -1 }))

      expect(result._tag).toBe('SaveDecodeError')
      expect(result.format).toBe('mc-save/test/score-only')
      expect(result.version).toBe(1)
      expect(result.reason).toBe('the value does not satisfy the format schema, so it cannot be encoded')
    }),
  )

  const UnknownFormat = defineFormat({
    name: 'mc-save/test/unknown',
    version: 1,
    schema: Schema.Unknown,
  })

  effect('reports unsupported encoded values as typed save errors', () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(encodeSave(UnknownFormat, new Date(0)))

      expect(result._tag).toBe('SaveDecodeError')
      expect(result.format).toBe('mc-save/test/unknown')
      expect(result.reason).toContain('only plain objects and Uint8Array values are supported')
    }),
  )

  effect('normalizes non-Error canonicalization failures', () =>
    Effect.gen(function* () {
      const throwingPayload = new Proxy(
        {},
        {
          ownKeys: () => {
            throw Object.create(null)
          },
        },
      )
      const result = yield* Effect.flip(encodeSave(UnknownFormat, throwingPayload))

      expect(result.reason).toContain('save contains an unsupported value')
    }),
  )
})

describe('format definition', () => {
  effect('reports why an envelope format name is blank', () =>
    Effect.sync(() => {
      expect(() =>
        Schema.decodeUnknownSync(SaveEnvelopeSchema)({ format: '   ', version: 1, payload: null }),
      ).toThrow('Save envelope format must be a non-blank string')
    }),
  )

  effect('reports invalid envelope scalar and payload values', () =>
    Effect.sync(() => {
      expect(() =>
        Schema.decodeUnknownSync(SaveEnvelopeSchema)({
          format: 'mc-save/test/invalid',
          version: Number.MAX_SAFE_INTEGER + 1,
          payload: null,
          integrity: { algorithm: 'fnv1a32', byteLength: 0, checksum: '00000000' },
        }),
      ).toThrow('Save envelope version must be a positive safe integer')

      expect(() =>
        Schema.decodeUnknownSync(SaveEnvelopeSchema)({
          format: 'mc-save/test/invalid',
          version: 1,
          payload: null,
          integrity: {
            algorithm: 'fnv1a32',
            byteLength: Number.MAX_SAFE_INTEGER + 1,
            checksum: '00000000',
          },
        }),
      ).toThrow('Save integrity byte length must be a non-negative safe integer')

      expect(() =>
        Schema.decodeUnknownSync(SaveEnvelopeSchema)({
          format: 'mc-save/test/invalid',
          version: 1,
          payload: undefined,
          integrity: { algorithm: 'fnv1a32', byteLength: 0, checksum: '00000000' },
        }),
      ).toThrow('Save envelope payload must be present')

      expect(() =>
        Schema.decodeUnknownSync(SaveEnvelopeDraftSchema)({ format: '   ', version: 1, payload: null }),
      ).toThrow('Save envelope format must be a non-blank string')

      expect(() =>
        Schema.decodeUnknownSync(SaveEnvelopeDraftSchema)({
          format: 'mc-save/test/invalid',
          version: 1,
          payload: undefined,
        }),
      ).toThrow('Save envelope payload must be present')
    }),
  )

  effect('returns a typed failure at definition time for a blank format name', () =>
    Effect.sync(() => {
      const result = defineFormatResult({ name: '  ', version: 1, schema: Schema.String })
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toContain('name must be a non-blank string')
    }),
  )

  effect('returns a typed failure at definition time for a version below the first supported version', () =>
    Effect.sync(() => {
      const result = defineFormatResult({
        name: 'mc-save/test/invalid-version',
        version: 0,
        schema: Schema.String,
      })
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.some((problem) => problem.includes('version must be a safe integer >= 1'))).toBe(true)
      }
    }),
  )

  effect('returns only the current format contract', () =>
    Effect.sync(() => {
      const result = defineFormatResult({
        name: 'mc-save/test/current',
        version: 1,
        schema: Schema.Unknown,
      })

      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(Object.keys(result.success).sort()).toStrictEqual(['name', 'schema', 'version'])
      }
    }),
  )

  effect('accepts a contiguous migration chain ending at the current version', () =>
    Effect.sync(() => {
      const fromOne = Result.getOrThrow(defineFormatMigrationResult({
        fromVersion: 1,
        schema: Schema.String,
        migrate: (value) => value,
      }))
      const fromTwo = Result.getOrThrow(defineFormatMigrationResult({
        fromVersion: 2,
        schema: Schema.String,
        migrate: (value) => ({ value }),
      }))
      const result = defineFormatResult({
        name: 'mc-save/test/migration-chain',
        version: 3,
        schema: Schema.Struct({ value: Schema.String }),
        migrations: [fromOne, fromTwo],
      })

      expect(Result.isFailure(result)).toBe(false)
      if (!Result.isFailure(result)) {
        expect(result.success.migrations?.map(({ fromVersion }) => fromVersion)).toStrictEqual([1, 2])
      }
    }),
  )

  effect('rejects duplicate, skipped, incomplete, and out-of-range migration steps', () =>
    Effect.sync(() => {
      const fromOne = Result.getOrThrow(defineFormatMigrationResult({
        fromVersion: 1,
        schema: Schema.String,
        migrate: (value) => value,
      }))
      const fromTwo = Result.getOrThrow(defineFormatMigrationResult({
        fromVersion: 2,
        schema: Schema.String,
        migrate: (value) => value,
      }))
      const fromThree = Result.getOrThrow(defineFormatMigrationResult({
        fromVersion: 3,
        schema: Schema.String,
        migrate: (value) => value,
      }))
      const define = (version: number, migrations: ReadonlyArray<typeof fromOne>) =>
        defineFormatResult({ name: 'mc-save/test/invalid-chain', version, schema: Schema.String, migrations })

      const duplicate = define(3, [fromOne, fromOne])
      const skipped = define(4, [fromOne, fromThree])
      const incomplete = define(4, [fromOne])
      const outOfRange = define(3, [fromOne, fromTwo, fromThree])

      expect(Result.isFailure(duplicate)).toBe(true)
      expect(Result.isFailure(skipped)).toBe(true)
      expect(Result.isFailure(incomplete)).toBe(true)
      expect(Result.isFailure(outOfRange)).toBe(true)
      if (Result.isFailure(duplicate)) expect(duplicate.failure.join(' ')).toContain('contiguous chain')
      if (Result.isFailure(skipped)) expect(skipped.failure.join(' ')).toContain('contiguous chain')
      if (Result.isFailure(incomplete)) expect(incomplete.failure.join(' ')).toContain('end at the current')
      if (Result.isFailure(outOfRange)) expect(outOfRange.failure.join(' ')).toContain('less than the current')
    }),
  )

  effect('returns Result failures for malformed migration definitions and lists', () =>
    Effect.sync(() => {
      const defineWithMigrations = (migrations: unknown) =>
        applyUntrustedArgument(defineFormatResult, undefined, [{
          name: 'mc-save/test/runtime-migrations',
          version: 2,
          schema: Schema.String,
          migrations,
        }])
      const defineMigration = (spec: unknown) =>
        applyUntrustedArgument(defineFormatMigrationResult, undefined, [spec])

      const nonArray = defineWithMigrations(null)
      const unreadableList = defineWithMigrations(new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') throw new Error('migration length getter failed')
          return Reflect.get(target, property, receiver)
        },
      }))
      const emptyList = defineWithMigrations([])
      const invalidEntry = defineWithMigrations([null])
      const unreadableEntry = defineWithMigrations([new Proxy({}, {
        get(target, property, receiver) {
          if (property === 'fromVersion') throw new Error('migration version getter failed')
          return Reflect.get(target, property, receiver)
        },
      })])
      const invalidVersion = defineWithMigrations([{ fromVersion: 0, migrate: (value: unknown) => value }])
      const invalidTransform = defineWithMigrations([{ fromVersion: 1, migrate: null }])

      expect(Result.isFailure(nonArray)).toBe(true)
      expect(Result.isFailure(unreadableList)).toBe(true)
      expect(Result.isSuccess(emptyList)).toBe(true)
      if (Result.isSuccess(emptyList)) expect(Object.hasOwn(emptyList.success, 'migrations')).toBe(false)
      expect(Result.isFailure(invalidEntry)).toBe(true)
      expect(Result.isFailure(unreadableEntry)).toBe(true)
      expect(Result.isFailure(invalidVersion)).toBe(true)
      expect(Result.isFailure(invalidTransform)).toBe(true)

      const unreadableDefinition = defineMigration(new Proxy(
        { fromVersion: 1, schema: Schema.String, migrate: (value: string) => value },
        {
          get(target, property, receiver) {
            if (property === 'schema') throw new Error('schema getter failed')
            return Reflect.get(target, property, receiver)
          },
        },
      ))
      const nonNumericVersion = defineMigration({
        fromVersion: '1',
        schema: Schema.String,
        migrate: (value: string) => value,
      })
      const nonCallableTransform = defineMigration({
        fromVersion: 1,
        schema: Schema.String,
        migrate: 1,
      })
      const invalidSchema = defineMigration({
        fromVersion: 1,
        schema: null,
        migrate: (value: unknown) => value,
      })

      expect(Result.isFailure(unreadableDefinition)).toBe(true)
      expect(Result.isFailure(nonNumericVersion)).toBe(true)
      expect(Result.isFailure(nonCallableTransform)).toBe(true)
      expect(Result.isSuccess(invalidSchema)).toBe(true)
      if (Result.isSuccess(invalidSchema)) {
        expect(Result.isFailure(invalidSchema.success.migrate('legacy'))).toBe(true)
      }
    }),
  )

  it('accepts positive safe migration source versions', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (fromVersion) => {
        const result = defineFormatMigrationResult({
          fromVersion,
          schema: Schema.String,
          migrate: (value) => value,
        })
        expect(Result.isFailure(result)).toBe(false)
      }),
    )
  })

  effect('rejects migration source versions at and outside the positive safe integer boundary', () =>
    Effect.sync(() => {
      for (const fromVersion of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const result = defineFormatMigrationResult({
          fromVersion,
          schema: Schema.String,
          migrate: (value) => value,
        })
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.join(' ')).toContain('safe integer >= 1')
        }
      }
    }),
  )

  effect('rejects unsafe versions and invalid runtime field types with Result failures', () =>
    Effect.sync(() => {
      const unsafeVersion = defineFormatResult({
        name: 'mc-save/test/unsafe-version',
        version: Number.MAX_SAFE_INTEGER + 1,
        schema: Schema.String,
      })
      expect(Result.isFailure(unsafeVersion)).toBe(true)
      if (Result.isFailure(unsafeVersion)) {
        expect(unsafeVersion.failure.some((problem) => problem.includes('version must be a safe integer >= 1'))).toBe(true)
      }

      const invalidFields = new Proxy(
        { name: 'mc-save/test/invalid-fields', version: 1, schema: Schema.String },
        {
          get: (target, property, receiver) =>
            property === 'name' ? 42 : property === 'version' ? '1' : Reflect.get(target, property, receiver),
        },
      )
      const invalidTypes = defineFormatResult(invalidFields)
      expect(Result.isFailure(invalidTypes)).toBe(true)
      if (Result.isFailure(invalidTypes)) {
        expect(invalidTypes.failure).toContain('format name and version have invalid types')
      }
    }),
  )

  effect('returns a typed failure when a definition getter cannot be read', () =>
    Effect.sync(() => {
      const definition = {
        get name(): string {
          throw new Error('name getter failed')
        },
        version: 1,
        schema: Schema.String,
      }
      const result = defineFormatResult(definition)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toStrictEqual(['format definition fields could not be read'])
      }
    }),
  )
})

describe('canonical integrity inputs', () => {
  effect('returns Result failures for values that do not satisfy their brands', () =>
    Effect.sync(() => {
      const canonicalError = applyUntrustedArgument(utf8Bytes, undefined, [null])
      const byteBufferError = applyUntrustedArgument(checksumOf, undefined, [null])

      expect(Result.isFailure(canonicalError) && canonicalError.failure).toBe('canonical JSON must be a string')
      expect(Result.isFailure(byteBufferError) && byteBufferError.failure).toBe('checksum input must be a Uint8Array')
    }),
  )

  effect('returns a Result failure when the UTF-8 view operation throws', () =>
    Effect.sync(() => {
      const NativeUint8Array = globalThis.Uint8Array
      vi.stubGlobal('Uint8Array', class extends NativeUint8Array {
        override subarray(): never {
          throw new Error('UTF-8 view could not be created')
        }
      })
      try {
        const result = utf8Bytes(CanonicalJson('{"value":1}'))
        expect(Result.isFailure(result) && result.failure).toBe('canonical JSON could not be encoded as UTF-8')
      } finally {
        vi.unstubAllGlobals()
      }
    }),
  )

  effect('returns a Result failure when a branded byte buffer cannot be read', () =>
    Effect.sync(() => {
      const unreadableBytes = new Proxy(new Uint8Array([1]), {
        get(target, property, receiver) {
          if (property === Symbol.iterator) throw new Error('unreadable bytes')
          return Reflect.get(target, property, receiver)
        },
      })

      const result = applyUntrustedArgument(checksumOf, undefined, [unreadableBytes])

      expect(Result.isFailure(result) && result.failure).toBe('checksum bytes could not be read')
    }),
  )
})
