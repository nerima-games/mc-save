import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, ParseResult, Schema } from 'effect'
import { SaveEnvelopeDraftSchema, SaveEnvelopeSchema } from '../src/domain/envelope.js'
import { decodeSave, defineFormat, encodeSave } from '../src/domain/format.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

/**
 * A format whose encoded form differs from its decoded form, so that a
 * round-trip test can actually fail. A format where `A` and `I` coincide would
 * pass `decode(encode(x)) === x` even if both were the identity.
 */
const PlayerStateSchema = Schema.Struct({
  worldId: Schema.String,
  health: Schema.Number.pipe(Schema.between(0, 20)),
  lastPlayed: Schema.DateFromNumber,
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
        expect(result.reason).toContain('only the current format version is accepted')
      }
    }),
  )

  /**
   * `encodeSave`'s own failure path, distinct from `decodeSave`'s: the value in
   * hand satisfies TypeScript but not the schema's ENCODE direction. A struct
   * whose field encoder can itself fail — as opposed to a struct that simply
   * rejects a wrong-shaped `unknown` on decode — is the only way to reach it.
   */
  const NonNegativeOnEncode = Schema.transformOrFail(Schema.Number, Schema.Number, {
    strict: true,
    decode: (n) => ParseResult.succeed(n),
    encode: (n, _options, ast) =>
      n < 0
        ? ParseResult.fail(new ParseResult.Type(ast, n, 'score must not be negative'))
        : ParseResult.succeed(n),
  })

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

      expect(result.reason).toBe('the encoded value is not storage-compatible')
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
      ).toThrow('Save envelope version must be a safe integer')

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
      ).toThrow('Save integrity byte length must be a safe integer')

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

  effect('throws at definition time for a blank format name', () =>
    Effect.sync(() => {
      expect(() => defineFormat({ name: '  ', version: 1, schema: Schema.String })).toThrow(
        /name must be a non-blank string/u,
      )
    }),
  )

  effect('throws at definition time for a version below the first supported version', () =>
    Effect.sync(() => {
      expect(() =>
        defineFormat({
          name: 'mc-save/test/invalid-version',
          version: 0,
          schema: Schema.String,
        }),
      ).toThrow(/version must be a safe integer >= 1/u)
    }),
  )

  effect('returns only the current format contract', () =>
    Effect.sync(() => {
      const format = defineFormat({
        name: 'mc-save/test/current',
        version: 1,
        schema: Schema.Unknown,
      })

      expect(Object.keys(format).sort()).toStrictEqual(['name', 'schema', 'version'])
    }),
  )
})
