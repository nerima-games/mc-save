import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { Effect, Option, Result, Schema, SchemaGetter } from 'effect'
import {
  readRevisionedSave,
  type RevisionStorage,
} from '../src/application/revisioned-save.js'
import { SaveDecodeError } from '../src/domain/errors.js'
import { decodeSave, defineFormat, encodeSave, type SaveFormat } from '../src/domain/format.js'
import type { SaveEnvelope } from '../src/domain/envelope.js'
import { sealSaveEnvelope, validateSaveEnvelope } from '../src/domain/integrity.js'
import { loadFrom } from '../src/domain/persistence.js'
import { makeInMemoryStorage, SaveKey, StoragePort } from '../src/domain/storage-port.js'

const byteArraySchema = Schema.Array(
  Schema.Number.check(Schema.makeFilter<number>((value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 255
      ? undefined
      : 'byte must be an integer between 0 and 255',
  )),
).pipe(
  Schema.decodeTo(Schema.Uint8Array, {
    decode: SchemaGetter.transform((bytes: ReadonlyArray<number>) => new Uint8Array(bytes)),
    encode: SchemaGetter.transform((bytes: Uint8Array) => Array.from(bytes)),
  }),
)

const saveSchema = Schema.Struct({ bytes: byteArraySchema })
const headSchema = Schema.Struct({
  revision: Schema.String,
  chunkKeys: Schema.Array(Schema.String),
  bytes: byteArraySchema,
})
const chunkSchema = Schema.Struct({ bytes: byteArraySchema })

const SAVE_FORMAT = Result.getOrThrow(defineFormat({
  name: 'mc-save/test/read-corruption/save',
  version: 1,
  schema: saveSchema,
}))
const HEAD_FORMAT = Result.getOrThrow(defineFormat({
  name: 'mc-save/test/read-corruption/head',
  version: 1,
  schema: headSchema,
}))
const CHUNK_FORMAT = Result.getOrThrow(defineFormat({
  name: 'mc-save/test/read-corruption/chunk',
  version: 1,
  schema: chunkSchema,
}))

const SAVE_RECORD_KEY = SaveKey('world/save')
const HEAD_RECORD_KEY = 'world/revision:head'
const LOGICAL_CHUNK_KEY = 'chunk-1'
const PHYSICAL_CHUNK_RECORD_KEY = 'world/revision:1/chunk-1'

const payloadByteMutationArbitrary = fc.array(fc.integer({ min: 0, max: 255 }), {
  minLength: 1,
  maxLength: 16,
}).chain((bytes) =>
  fc.integer({ min: 0, max: bytes.length - 1 }).map((byteIndex) => ({ bytes, byteIndex })),
)

const makeEnvelope = <A, I>(format: SaveFormat<A, I>, value: A): SaveEnvelope => {
  const draft = Effect.runSync(encodeSave(format, value))
  return Result.getOrThrow(sealSaveEnvelope(draft))
}

const corruptEnvelopeByte = <A extends { readonly bytes: Uint8Array }, I>(
  format: SaveFormat<A, I>,
  envelope: SaveEnvelope,
  byteIndex: number,
): SaveEnvelope => {
  const value = Schema.decodeUnknownSync(format.schema)(envelope.payload)
  const bytes = Uint8Array.from(value.bytes, (byte, index) =>
    index === byteIndex ? (byte + 1) % 256 : byte,
  )
  const payload = Schema.encodeUnknownSync(format.schema)({ ...value, bytes })
  return { ...envelope, payload }
}

const readSaveFailure = (envelope: SaveEnvelope) =>
  Effect.gen(function* () {
    const storage = yield* makeInMemoryStorage
    yield* storage.put(SAVE_RECORD_KEY, envelope)
    return yield* Effect.flip(
      loadFrom(SAVE_FORMAT, SAVE_RECORD_KEY).pipe(Effect.provideService(StoragePort, storage)),
    )
  })

const makeRevisionStorage = <Raw>(
  initial: ReadonlyArray<readonly [string, Raw]>,
): RevisionStorage<string, Raw, never, never> => {
  const values = new Map(initial)
  return {
    get: (key) => Effect.succeed(Option.fromUndefinedOr(values.get(key))),
    put: (key, value) => Effect.sync(() => {
      values.set(key, value)
    }),
    remove: (key) => Effect.sync(() => {
      values.delete(key)
    }),
  }
}

const decodeCheckedEnvelope = <A, I>(
  format: SaveFormat<A, I>,
  envelope: SaveEnvelope,
) => validateSaveEnvelope(envelope).pipe(
  Effect.flatMap((validated) => decodeSave(format, validated)),
)

const makeCheckedRevisionReader = (
  storage: RevisionStorage<string, SaveEnvelope, never, never>,
) => ({
  storage,
  headKey: HEAD_RECORD_KEY,
  chunkKey: (_head: SaveEnvelope, _key: string) => PHYSICAL_CHUNK_RECORD_KEY,
  lastHealthyRevisionAvailable: true,
  decodeHead: (rawHead: SaveEnvelope) => decodeCheckedEnvelope(HEAD_FORMAT, rawHead),
  chunkKeysFromHead: (head: typeof headSchema.Type) => Effect.succeed(head.chunkKeys),
  decodeChunk: (rawChunk: SaveEnvelope) => decodeCheckedEnvelope(CHUNK_FORMAT, rawChunk),
  missingChunkError: (_head: typeof headSchema.Type, key: string) => new SaveDecodeError({
    format: CHUNK_FORMAT.name,
    version: CHUNK_FORMAT.version,
    reason: `chunk ${key} is missing`,
  }),
  keyToString: (key: string) => SaveKey(key),
})

const makeUncheckedChunkReader = (
  storage: RevisionStorage<string, SaveEnvelope | Uint8Array, never, never>,
) => ({
  storage,
  headKey: HEAD_RECORD_KEY,
  chunkKey: (_head: SaveEnvelope | Uint8Array, _key: string) => PHYSICAL_CHUNK_RECORD_KEY,
  lastHealthyRevisionAvailable: true,
  decodeHead: (rawHead: SaveEnvelope | Uint8Array) =>
    rawHead instanceof Uint8Array
      ? Effect.fail(new SaveDecodeError({ format: HEAD_FORMAT.name, version: 1, reason: 'head is not an envelope' }))
      : decodeCheckedEnvelope(HEAD_FORMAT, rawHead),
  chunkKeysFromHead: (head: typeof headSchema.Type) => Effect.succeed(head.chunkKeys),
  decodeChunk: (rawChunk: SaveEnvelope | Uint8Array) =>
    rawChunk instanceof Uint8Array
      ? Effect.succeed(rawChunk)
      : Effect.fail(new SaveDecodeError({ format: CHUNK_FORMAT.name, version: 1, reason: 'chunk is not opaque bytes' })),
  missingChunkError: (_head: typeof headSchema.Type, key: string) => new SaveDecodeError({
    format: CHUNK_FORMAT.name,
    version: CHUNK_FORMAT.version,
    reason: `chunk ${key} is missing`,
  }),
  keyToString: (key: string) => SaveKey(key),
})

const headEnvelope = () => makeEnvelope(HEAD_FORMAT, {
  revision: '1',
  chunkKeys: [LOGICAL_CHUNK_KEY],
  bytes: new Uint8Array([11]),
})

describe('typed failures for corrupted record bytes', () => {
  it('returns a Save failure naming the key for any changed payload byte', () => {
    fc.assert(fc.property(payloadByteMutationArbitrary, ({ bytes, byteIndex }) => {
      const envelope = makeEnvelope(SAVE_FORMAT, { bytes: Uint8Array.from(bytes) })
      const corrupted = corruptEnvelopeByte(SAVE_FORMAT, envelope, byteIndex)
      const error = Effect.runSync(readSaveFailure(corrupted))

      expect(error._tag).toBe('SaveDecodeError')
      if (error._tag !== 'SaveDecodeError') return
      expect(error.record).toStrictEqual({ _tag: 'Save', key: SAVE_RECORD_KEY })
    }), { numRuns: 50 })
  })

  it('returns a Head failure naming the key for any changed payload byte', () => {
    fc.assert(fc.property(payloadByteMutationArbitrary, ({ bytes, byteIndex }) => {
      const healthyHead = makeEnvelope(HEAD_FORMAT, {
        revision: '1',
        chunkKeys: [LOGICAL_CHUNK_KEY],
        bytes: Uint8Array.from(bytes),
      })
      const corruptedHead = corruptEnvelopeByte(HEAD_FORMAT, healthyHead, byteIndex)
      const storage = makeRevisionStorage([
        [HEAD_RECORD_KEY, corruptedHead],
      ])
      const error = Effect.runSync(Effect.flip(
        readRevisionedSave(makeCheckedRevisionReader(storage)),
      ))

      expect(error._tag).toBe('SaveDecodeError')
      if (error._tag !== 'SaveDecodeError') return
      expect(error.record).toStrictEqual({ _tag: 'Head', key: SaveKey(HEAD_RECORD_KEY) })
    }), { numRuns: 50 })
  })

  it('returns a Chunk failure naming the physical key for any changed payload byte', () => {
    fc.assert(fc.property(payloadByteMutationArbitrary, ({ bytes, byteIndex }) => {
      const healthyChunk = makeEnvelope(CHUNK_FORMAT, { bytes: Uint8Array.from(bytes) })
      const corruptedChunk = corruptEnvelopeByte(CHUNK_FORMAT, healthyChunk, byteIndex)
      const storage = makeRevisionStorage([
        [HEAD_RECORD_KEY, headEnvelope()],
        [PHYSICAL_CHUNK_RECORD_KEY, corruptedChunk],
      ])
      const loaded = Effect.runSync(readRevisionedSave(makeCheckedRevisionReader(storage)))

      expect(Option.isSome(loaded)).toBe(true)
      if (Option.isNone(loaded)) return
      expect(loaded.value.chunks).toHaveLength(0)
      expect(loaded.value.failures).toHaveLength(1)
      const failure = loaded.value.failures[0]
      expect(failure?._tag).toBe('SaveDecodeError')
      if (failure === undefined || failure._tag !== 'SaveDecodeError') return
      expect(failure.record).toStrictEqual({
        _tag: 'Chunk',
        key: SaveKey(PHYSICAL_CHUNK_RECORD_KEY),
      })
      expect(failure.repair?.discardableChunkKeys).toStrictEqual([
        SaveKey(PHYSICAL_CHUNK_RECORD_KEY),
      ])
    }), { numRuns: 50 })
  })

  it('returns changed bytes when the caller decoder accepts an unchecked opaque chunk', () => {
    fc.assert(fc.property(payloadByteMutationArbitrary, ({ bytes, byteIndex }) => {
      const originalChunk = Uint8Array.from(bytes)
      const changedChunk = Uint8Array.from(originalChunk, (byte, index) =>
        index === byteIndex ? (byte + 1) % 256 : byte,
      )
      const storage = makeRevisionStorage<SaveEnvelope | Uint8Array>([
        [HEAD_RECORD_KEY, headEnvelope()],
        [PHYSICAL_CHUNK_RECORD_KEY, changedChunk],
      ])
      const loaded = Effect.runSync(readRevisionedSave(makeUncheckedChunkReader(storage)))

      expect(Option.isSome(loaded)).toBe(true)
      if (Option.isNone(loaded)) return
      expect(loaded.value.chunks).toStrictEqual([{ key: LOGICAL_CHUNK_KEY, value: changedChunk }])
      expect(loaded.value.failures).toStrictEqual([])
    }), { numRuns: 50 })
  })
})
