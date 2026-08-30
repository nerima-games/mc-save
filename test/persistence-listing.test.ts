import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Layer, Option, Schema } from 'effect'
import { StorageError } from '../src/domain/errors.js'
import type { SaveEnvelope } from '../src/domain/envelope.js'
import { defineFormat } from '../src/domain/format.js'
import { durablePreviousKey } from '../src/domain/durable-key.js'
import { listFrom, loadFrom } from '../src/domain/persistence.js'
import { makeInMemoryStorage, SaveKey, StoragePort, type StorageService } from '../src/domain/storage-port.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

const World = defineFormat({
  name: 'mc-save/test/world-listing',
  version: 1,
  schema: Schema.Struct({ name: Schema.String }),
})

const FIRST = SaveKey('world/first')
const BROKEN = SaveKey('world/broken')
const SECOND = SaveKey('world/second')
const FOREIGN = SaveKey('world/foreign')

// Widens a value's static type to `T` with NO runtime transformation and no type assertion:
// `Record<string, any>` indexing is `any` by construction, assignable anywhere with zero compiler
// complaint. Used to store a malformed, non-envelope-shaped value so the test proves runtime
// well-formedness validation — not the type checker — rejects it.
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
      })
      expect(listed.corrupt[1]?.reason).toContain('another-format')
      expect(listed.corrupt.every((failure) => !('cause' in failure))).toBe(true)
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
      expect(error.operation).toBe('test.get')
      expect(error.key).toBe(SECOND)
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
})

describe('loadFrom', () => {
  effect('returns no value when the key is absent', () =>
    Effect.gen(function* () {
      expect(yield* loadFrom(World, SaveKey('world/missing'))).toStrictEqual(Option.none())
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )

  effect('rejects a stored value that is not a well-formed envelope', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(BROKEN, widen<SaveEnvelope>({ format: '', version: 0, payload: null }))

      const result = yield* Effect.flip(loadFrom(World, BROKEN))

      expect(result._tag).toBe('SaveDecodeError')
      if (result._tag === 'SaveDecodeError') {
        expect(result.version).toBe(0)
        expect(result.reason).toBe(`the stored value at "${BROKEN}" is not a well-formed save envelope`)
      }
    }).pipe(Effect.provide(Layer.effect(StoragePort, makeInMemoryStorage))),
  )
})
