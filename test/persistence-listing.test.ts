import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { effect } from './support/effect-test.js'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import { StorageError, type SaveRepairGuidance } from '../src/domain/errors.js'
import type { SaveEnvelope } from '../src/domain/envelope.js'
import { defineFormat as defineFormatResult } from '../src/domain/format.js'
import { durablePreviousKey } from '../src/domain/durable-key.js'
import { listFrom, loadFrom, saveTo } from '../src/domain/persistence.js'
import { makeInMemoryStorage, SaveKey, StoragePort, type StorageService } from '../src/domain/storage-port.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<A, I>
}) => Result.getOrThrow(defineFormatResult(spec))
const World = defineFormat({
  name: 'mc-save/test/world-listing',
  version: 1,
  schema: Schema.Struct({ name: Schema.String }),
})

const FIRST = SaveKey('world/first')
const BROKEN = SaveKey('world/broken')
const SECOND = SaveKey('world/second')
const FOREIGN = SaveKey('world/foreign')
const CHUNK = SaveKey('world/chunk')
const HEAD = SaveKey('world/head')

// A deliberately malformed value is returned by the test storage service to
// exercise the read boundary without asking a real adapter to persist invalid data.
const widen = <T,>(value: unknown): T => {
  const bag: Record<string, any> = {}
  bag['value'] = value
  return bag['value']
}

describe('listFrom', () => {
  effect('hides durable checkpoint records from user listings', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(FIRST, sealedTestEnvelope(World.name, 1, { name: 'first' }))
      yield* storage.put(durablePreviousKey(FIRST), sealedTestEnvelope(World.name, 1, { name: 'checkpoint' }))

      const listed = yield* listFrom(World)

      expect(listed).toStrictEqual({
        valid: [{ key: FIRST, value: { name: 'first' } }],
        corrupt: [],
      })
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('isolates multiple corrupt records while preserving order in both partitions', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(FIRST, sealedTestEnvelope(World.name, 1, { name: 'first' }))
      yield* storage.put(BROKEN, sealedTestEnvelope(World.name, 1, { name: 42 }))
      yield* storage.put(durablePreviousKey(BROKEN), sealedTestEnvelope(World.name, 1, { name: 'checkpoint' }))
      yield* storage.put(SECOND, sealedTestEnvelope(World.name, 1, { name: 'second' }))
      yield* storage.put(FOREIGN, sealedTestEnvelope('another-format', 1, { name: 'foreign' }))

      const listed = yield* listFrom(World)

      expect(listed.valid).toStrictEqual([
        { key: FIRST, value: { name: 'first' } },
        { key: SECOND, value: { name: 'second' } },
      ])
      expect(listed.corrupt.map(({ key }) => key)).toStrictEqual([BROKEN, FOREIGN])
      expect(listed.corrupt[0]).toMatchObject({
        _tag: 'SaveDecodeError',
        key: BROKEN,
        format: World.name,
        version: 1,
        reason: 'the payload does not satisfy the current schema',
        record: { _tag: 'Save', key: BROKEN },
        repair: { lastHealthyRevisionAvailable: true, discardableChunkKeys: [] },
      })
      expect(listed.corrupt[1]?.reason).toContain('another-format')
      expect(listed.corrupt[1]).toMatchObject({
        record: { _tag: 'Save', key: FOREIGN },
        repair: { lastHealthyRevisionAvailable: false, discardableChunkKeys: [] },
      })
      expect(listed.corrupt.every((failure) => !('cause' in failure))).toBe(true)
      expect(JSON.stringify(listed.corrupt)).not.toContain('checkpoint')
      expect(JSON.stringify(listed.corrupt)).not.toContain('42')
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('fails the whole listing when reading the storage medium fails', () => {
    const service: StorageService = {
      keys: Effect.succeed([FIRST, SECOND]),
      get: (key) =>
        key === FIRST
          ? Effect.succeed(Option.some(sealedTestEnvelope(World.name, 1, { name: 'first' })))
          : Effect.fail(new StorageError({ operation: 'test.get', key })),
      put: () => Effect.void,
      remove: () => Effect.void,
      commitBatch: () => Effect.void,
      readBatch: (keys) => Effect.all(keys.map((key) => service.get(key))),
    }

    return Effect.gen(function* () {
      const error = yield* Effect.flip(listFrom(World))
      expect(error._tag).toBe('StorageError')
      if (error._tag === 'StorageError') {
        expect(error.operation).toBe('test.get')
        expect(error.key).toBe(SECOND)
      }
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })

  effect('fails without reading records when key enumeration fails', () => {
    const failure = new StorageError({ operation: 'test.keys' })
    const service: StorageService = {
      keys: Effect.fail(failure),
      get: () => Effect.die('must not read a key after listing failed'),
      put: () => Effect.void,
      remove: () => Effect.void,
      commitBatch: () => Effect.void,
      readBatch: () => Effect.die('must not batch-read after listing failed'),
    }

    return Effect.gen(function* () {
      expect(yield* Effect.flip(listFrom(World))).toBe(failure)
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })

  effect('fails on an invalid read limit before enumerating an empty listing', () => {
    let enumerated = false
    const service: StorageService = {
      keys: Effect.sync(() => {
        enumerated = true
        return []
      }),
      get: () => Effect.die('must not read records for an empty listing'),
      put: () => Effect.void,
      remove: () => Effect.void,
      commitBatch: () => Effect.void,
      readBatch: () => Effect.succeed([]),
    }

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        listFrom(World, widen<Parameters<typeof listFrom>[1]>({ maxBytes: null })),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('SaveDecodeError')
        if (result.failure._tag === 'SaveDecodeError') {
          expect(result.failure.reason).toBe('maxBytes must be a non-negative safe integer')
        }
      }
      expect(enumerated).toBe(false)
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })

  effect('fails closed when a forged runtime format produces malformed decode metadata', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(FIRST, sealedTestEnvelope(World.name, 1, { name: 'first' }))
      const forgedFormat = widen<typeof World>({ ...World, name: null })

      const result = yield* Effect.result(listFrom(forgedFormat))

      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure).toMatchObject({
          _tag: 'StorageError',
          operation: 'persistence.listFrom',
          key: FIRST,
          cause: 'save decode error fields are malformed',
        })
      }
      expect(yield* storage.keys).toStrictEqual([FIRST])
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  it('reports future versions as typed per-record failures for arbitrary version values', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 1_000_000 }), async (version) => {
        const key = SaveKey(`world/future/${version}`)
        const listed = await Effect.runPromise(
          Effect.gen(function* () {
            const storage = yield* StoragePort
            yield* storage.put(key, sealedTestEnvelope(World.name, version, { ignored: true }))
            return yield* listFrom(World)
          }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
        )

        expect(listed.valid).toStrictEqual([])
        expect(listed.corrupt).toHaveLength(1)
        expect(listed.corrupt[0]).toMatchObject({
          _tag: 'SaveDecodeError',
          key,
          format: World.name,
          version,
          record: { _tag: 'Save', key },
          repair: { lastHealthyRevisionAvailable: false, discardableChunkKeys: [] },
        })
        expect(listed.corrupt[0]?.reason).toContain(`v${version}`)
        expect(JSON.stringify(listed.corrupt)).not.toContain('cause')
        expect(JSON.stringify(listed.corrupt)).not.toContain('ignored')
      }),
    )
  })

  effect('reports the maximum safe envelope version without throwing', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(
        BROKEN,
        sealedTestEnvelope(World.name, Number.MAX_SAFE_INTEGER, { ignored: true }),
      )

      const listed = yield* listFrom(World)

      expect(listed.valid).toStrictEqual([])
      expect(listed.corrupt).toHaveLength(1)
      expect(listed.corrupt[0]).toMatchObject({
        key: BROKEN,
        version: Number.MAX_SAFE_INTEGER,
        record: { _tag: 'Save', key: BROKEN },
      })
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('does not advertise an invalid durable checkpoint as a repair option', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(BROKEN, sealedTestEnvelope(World.name, 1, { name: 42 }))
      yield* storage.put(durablePreviousKey(BROKEN), sealedTestEnvelope(World.name, 1, { name: 99 }))

      const listed = yield* listFrom(World)

      expect(listed.corrupt).toHaveLength(1)
      expect(listed.corrupt[0]?.repair).toStrictEqual({
        lastHealthyRevisionAvailable: false,
        discardableChunkKeys: [],
      })
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )
})

describe('saveTo', () => {
  effect('rejects null and unreadable write options without writing a save', () => {
    const getterFailure = new Error('write options could not be read')
    const unreadableOptions = Object.defineProperty({}, 'extensions', {
      get: () => {
        throw getterFailure
      },
    })

    return Effect.gen(function* () {
      const storage = yield* StoragePort
      const nullOptions = yield* Effect.result(
        saveTo(World, FIRST, { name: 'null options' }, widen<Parameters<typeof saveTo>[3]>(null)),
      )
      expect(nullOptions._tag).toBe('Failure')
      if (nullOptions._tag === 'Failure') {
        expect(nullOptions.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'save write options could not be read',
        })
      }

      const unreadable = yield* Effect.result(
        saveTo(World, FIRST, { name: 'unreadable options' }, widen<Parameters<typeof saveTo>[3]>(unreadableOptions)),
      )
      expect(unreadable._tag).toBe('Failure')
      if (unreadable._tag === 'Failure') {
        expect(unreadable.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'save write options could not be read',
          cause: getterFailure,
        })
      }
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage)))
  })

})

describe('loadFrom', () => {
  effect('returns no value when the key is absent', () =>
    Effect.gen(function* () {
      expect(yield* loadFrom(World, SaveKey('world/missing'))).toStrictEqual(Option.none())
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('rejects null and unreadable read options before accessing storage', () => {
    let lookedUp = false
    const service: StorageService = {
      keys: Effect.succeed([]),
      get: () => {
        lookedUp = true
        return Effect.die('must not read storage for invalid options')
      },
      put: () => Effect.void,
      remove: () => Effect.void,
      commitBatch: () => Effect.void,
      readBatch: () => Effect.succeed([]),
    }

    return Effect.gen(function* () {
      const nullOptions = yield* Effect.result(
        loadFrom(World, FIRST, widen<Parameters<typeof loadFrom>[2]>(null)),
      )
      expect(nullOptions._tag).toBe('Failure')
      if (nullOptions._tag === 'Failure') {
        expect(nullOptions.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'save read options could not be read',
        })
      }

      const getterFailure = new Error('read options could not be read')
      const unreadableOptions = new Proxy({}, {
        get: (_target, property) => {
          if (property === 'maxBytes') throw getterFailure
          return undefined
        },
      })
      const unreadable = yield* Effect.result(
        loadFrom(World, FIRST, widen<Parameters<typeof loadFrom>[2]>(unreadableOptions)),
      )
      expect(unreadable._tag).toBe('Failure')
      if (unreadable._tag === 'Failure') {
        expect(unreadable.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'save read options could not be read',
          cause: getterFailure,
        })
      }

      const recordGetterFailure = new Error('record option could not be read')
      const unreadableRecord = new Proxy({}, {
        get: (_target, property) => {
          if (property === 'record') throw recordGetterFailure
          return undefined
        },
      })
      const recordGetterResult = yield* Effect.result(
        loadFrom(World, FIRST, widen<Parameters<typeof loadFrom>[2]>(unreadableRecord)),
      )
      expect(recordGetterResult._tag).toBe('Failure')
      if (recordGetterResult._tag === 'Failure') {
        expect(recordGetterResult.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'save read options could not be read',
          cause: recordGetterFailure,
        })
      }

      const repairGetterFailure = new Error('repair option could not be read')
      const unreadableRepairGetter = new Proxy({}, {
        get: (_target, property) => {
          if (property === 'repair') throw repairGetterFailure
          return undefined
        },
      })
      const repairGetterResult = yield* Effect.result(
        loadFrom(World, FIRST, widen<Parameters<typeof loadFrom>[2]>(unreadableRepairGetter)),
      )
      expect(repairGetterResult._tag).toBe('Failure')
      if (repairGetterResult._tag === 'Failure') {
        expect(repairGetterResult.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'save read options could not be read',
          cause: repairGetterFailure,
        })
      }

      const invalidRecord = yield* Effect.result(
        loadFrom(World, FIRST, widen<Parameters<typeof loadFrom>[2]>({ record: 'manifest' })),
      )
      expect(invalidRecord._tag).toBe('Failure')
      if (invalidRecord._tag === 'Failure') {
        expect(invalidRecord.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'save read options could not be read',
        })
      }

      const invalidRepair = yield* Effect.result(
        loadFrom(World, FIRST, widen<Parameters<typeof loadFrom>[2]>({ repair: null })),
      )
      expect(invalidRepair._tag).toBe('Failure')
      if (invalidRepair._tag === 'Failure') {
        expect(invalidRepair.failure).toMatchObject({
          _tag: 'SaveDecodeError',
          reason: 'save read options could not be read',
        })
      }
      expect(lookedUp).toBe(false)
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })

  effect('attaches caller-provided head repair guidance to decode failures', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(HEAD, sealedTestEnvelope(World.name, 1, { name: 42 }))
      const repair: SaveRepairGuidance = {
        lastHealthyRevisionAvailable: true,
        discardableChunkKeys: ['world/chunk/unreadable'],
      }

      const error = yield* Effect.flip(loadFrom(World, HEAD, { record: 'Head', repair }))

      expect(error._tag).toBe('SaveDecodeError')
      if (error._tag === 'SaveDecodeError') {
        expect(error.record).toStrictEqual({ _tag: 'Head', key: HEAD })
        expect(error.repair).toStrictEqual(repair)
      }
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('does not infer a head checkpoint for a failed chunk read', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(CHUNK, sealedTestEnvelope(World.name, 1, { name: 42 }))
      yield* storage.put(durablePreviousKey(CHUNK), sealedTestEnvelope(World.name, 1, { name: 'checkpoint' }))

      const error = yield* Effect.flip(loadFrom(World, CHUNK, { record: 'Chunk' }))

      expect(error._tag).toBe('SaveDecodeError')
      if (error._tag === 'SaveDecodeError') {
        expect(error.record).toStrictEqual({ _tag: 'Chunk', key: CHUNK })
        expect(error.repair).toStrictEqual({
          lastHealthyRevisionAvailable: false,
          discardableChunkKeys: [],
        })
      }
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('detects only decodable durable checkpoints for default save and head errors', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const validBackup = SaveKey('world/broken-with-valid-backup')
      const invalidBackup = SaveKey('world/broken-with-invalid-backup')
      const headWithBackup = SaveKey('world/broken-head-with-backup')
      yield* storage.put(validBackup, sealedTestEnvelope(World.name, 1, { name: 42 }))
      yield* storage.put(durablePreviousKey(validBackup), sealedTestEnvelope(World.name, 1, { name: 'valid' }))
      yield* storage.put(invalidBackup, sealedTestEnvelope(World.name, 1, { name: 42 }))
      yield* storage.put(durablePreviousKey(invalidBackup), sealedTestEnvelope(World.name, 1, { name: 99 }))
      yield* storage.put(headWithBackup, sealedTestEnvelope(World.name, 1, { name: 42 }))
      yield* storage.put(durablePreviousKey(headWithBackup), sealedTestEnvelope(World.name, 1, { name: 'head backup' }))

      const validError = yield* Effect.flip(loadFrom(World, validBackup))
      const invalidError = yield* Effect.flip(loadFrom(World, invalidBackup))
      const headError = yield* Effect.flip(loadFrom(World, headWithBackup, { record: 'Head' }))

      expect(validError._tag).toBe('SaveDecodeError')
      if (validError._tag === 'SaveDecodeError') {
        expect(validError.record).toStrictEqual({ _tag: 'Save', key: validBackup })
        expect(validError.repair?.lastHealthyRevisionAvailable).toBe(true)
      }
      expect(invalidError._tag).toBe('SaveDecodeError')
      if (invalidError._tag === 'SaveDecodeError') {
        expect(invalidError.record).toStrictEqual({ _tag: 'Save', key: invalidBackup })
        expect(invalidError.repair?.lastHealthyRevisionAvailable).toBe(false)
      }
      expect(headError._tag).toBe('SaveDecodeError')
      if (headError._tag === 'SaveDecodeError') {
        expect(headError.record).toStrictEqual({ _tag: 'Head', key: headWithBackup })
        expect(headError.repair?.lastHealthyRevisionAvailable).toBe(true)
      }
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('adds recovery metadata without preserving an absent decode cause', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(
        HEAD,
        sealedTestEnvelope(World.name, World.version + 1, { name: 'future' }),
      )

      const error = yield* Effect.flip(loadFrom(World, HEAD))

      expect(error._tag).toBe('SaveDecodeError')
      if (error._tag === 'SaveDecodeError') {
        expect(error.cause).toBeUndefined()
        expect(error.record).toStrictEqual({ _tag: 'Save', key: HEAD })
        expect(error.repair?.lastHealthyRevisionAvailable).toBe(false)
      }
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('fails when storage returns null instead of an Option for a stored key', () => {
    const service: StorageService = {
      keys: Effect.succeed([FIRST]),
      get: () => Effect.succeed(widen<Option.Option<SaveEnvelope>>(null)),
      put: () => Effect.void,
      remove: () => Effect.void,
      commitBatch: () => Effect.void,
      readBatch: () => Effect.succeed([]),
    }

    return Effect.gen(function* () {
      const result = yield* Effect.result(loadFrom(World, FIRST))
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('StorageError')
        if (result.failure._tag === 'StorageError') expect(result.failure.key).toBe(FIRST)
      }
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })

  effect('fails when a supplied read limit is null instead of using the default', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(FIRST, sealedTestEnvelope(World.name, 1, { name: 'value' }))

      const result = yield* Effect.flip(
        loadFrom(World, FIRST, widen<Parameters<typeof loadFrom>[2]>({ maxBytes: null })),
      )

      expect(result._tag).toBe('SaveDecodeError')
      if (result._tag === 'SaveDecodeError') {
        expect(result.reason).toBe('maxBytes must be a non-negative safe integer')
      }
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('validates a read limit before returning none for a missing key', () => {
    let lookedUp = false
    const service: StorageService = {
      keys: Effect.succeed([]),
      get: () => {
        lookedUp = true
        return Effect.succeed(Option.none())
      },
      put: () => Effect.void,
      remove: () => Effect.void,
      commitBatch: () => Effect.void,
      readBatch: () => Effect.succeed([]),
    }

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        loadFrom(World, SaveKey('world/missing'), widen<Parameters<typeof loadFrom>[2]>({ maxBytes: null })),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('SaveDecodeError')
        if (result.failure._tag === 'SaveDecodeError') {
          expect(result.failure.reason).toBe('maxBytes must be a non-negative safe integer')
        }
      }
      expect(lookedUp).toBe(false)
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })

  effect('rejects a stored value that is not a well-formed envelope', () => {
    const malformed = widen<SaveEnvelope>({ format: '', version: 0, payload: null })
    const storage: StorageService = {
      keys: Effect.succeed([BROKEN]),
      get: () => Effect.succeed(Option.some(malformed)),
      put: () => Effect.void,
      remove: () => Effect.void,
      commitBatch: () => Effect.void,
      readBatch: () => Effect.succeed([Option.some(malformed)]),
    }
    return Effect.gen(function* () {
      const result = yield* Effect.flip(loadFrom(World, BROKEN))

      expect(result._tag).toBe('SaveDecodeError')
      if (result._tag === 'SaveDecodeError') {
        expect(result.version).toBe(0)
        expect(result.reason).toBe(`the stored value at "${BROKEN}" is not a well-formed save envelope`)
        expect(result.record).toStrictEqual({ _tag: 'Save', key: BROKEN })
        expect(result.repair?.lastHealthyRevisionAvailable).toBe(false)
      }
    }).pipe(Effect.provide(Layer.succeed(StoragePort, storage)))
  })

  effect('maps an unreadable stored envelope getter to SaveDecodeError', () => {
    const getterFailure = new Error('stored envelope could not be read')
    const unreadable = new Proxy(sealedTestEnvelope(World.name, 1, { name: 'value' }), {
      get: (target, property, receiver) => {
        if (property === 'format') throw getterFailure
        return Reflect.get(target, property, receiver)
      },
    })
    const service: StorageService = {
      keys: Effect.succeed([BROKEN]),
      get: () => Effect.succeed(Option.some(unreadable)),
      put: () => Effect.void,
      remove: () => Effect.void,
      commitBatch: () => Effect.void,
      readBatch: (keys) => Effect.all(keys.map((key) => service.get(key))),
    }

    return Effect.gen(function* () {
      const error = yield* Effect.flip(loadFrom(World, BROKEN))
      expect(error._tag).toBe('SaveDecodeError')
      if (error._tag === 'SaveDecodeError') {
        expect(error.reason).toBe(`the stored value at "${BROKEN}" could not be read as a save envelope`)
        expect(error.cause).toBeInstanceOf(Error)
        expect(error.record).toStrictEqual({ _tag: 'Save', key: BROKEN })
        expect(error.repair?.lastHealthyRevisionAvailable).toBe(false)
      }
    }).pipe(Effect.provide(Layer.succeed(StoragePort, service)))
  })
})

describe('saveTo', () => {
  effect('fails when a supplied write limit is null instead of using the default', () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        saveTo(World, FIRST, { name: 'value' }, widen<Parameters<typeof saveTo>[3]>({ maxBytes: null })),
      )

      expect(result._tag).toBe('SaveDecodeError')
      if (result._tag === 'SaveDecodeError') {
        expect(result.reason).toBe('maxBytes must be a non-negative safe integer')
      }
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )
})
