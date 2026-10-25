import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Option, Result } from 'effect'
import { StorageOperation } from '../src/domain/brand-types.js'
import { StorageError } from '../src/domain/errors.js'
import { failingStorageLayer, InMemoryStorageLayer, SaveKey, StoragePort } from '../src/domain/storage-port.js'
import { storagePortContract } from './storage-port-contract.js'
import { sealedTestEnvelope } from './support/save-envelope.js'

/**
 * These are contract tests, not tests of the in-memory adapter.
 *
 * Every assertion is phrased against `StoragePort` rather than against the
 * implementation, so the whole block can be re-run against another adapter. It
 * now is: the block itself lives in `test/storage-port-contract.ts` and is run
 * from here against `InMemoryStorageLayer` and from
 * `test/indexeddb-storage.test.ts` against the IndexedDB adapter. Not one
 * assertion changed when it moved.
 *
 * The shared contract keeps these assertions independent of the adapter. The
 * same block is run against the in-memory and IndexedDB implementations, so a
 * backend cannot silently develop semantics that differ from production.
 */

const A = SaveKey('alpha')
const envelope = (payload: unknown) => sealedTestEnvelope('mc-save/test/contract', 1, payload)

const applyUntrustedArgument = <This, Args extends ReadonlyArray<unknown>, A, E, R>(
  method: (this: This, ...args: Args) => Effect.Effect<A, E, R>,
  receiver: This,
  argumentsList: ReadonlyArray<unknown>,
): Effect.Effect<A, E, R> => Reflect.apply(method, receiver, argumentsList)

storagePortContract('in-memory', () => InMemoryStorageLayer)

describe('in-memory runtime inputs', () => {
  effect('rejects an undefined envelope before it can be stored as an absent value', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const error = yield* Effect.flip(applyUntrustedArgument(storage.put, storage, [A, undefined]))

      expect(error).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.put' })
      expect(yield* storage.get(A)).toStrictEqual(Option.none())
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('rejects null and blank keys instead of returning Option.none', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort

      for (const key of [null, '']) {
        const result = yield* Effect.result(applyUntrustedArgument(storage.get, storage, [key]))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.get' })
        }
      }

      const putError = yield* Effect.result(applyUntrustedArgument(storage.put, storage, [null, envelope({})]))
      expect(Result.isFailure(putError)).toBe(true)
      if (Result.isFailure(putError)) {
        expect(putError.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.put' })
      }

      const removeError = yield* Effect.result(applyUntrustedArgument(storage.remove, storage, ['']))
      expect(Result.isFailure(removeError)).toBe(true)
      if (Result.isFailure(removeError)) {
        expect(removeError.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.remove' })
      }

      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('rejects an explicit null envelope instead of treating it as an absent value', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const result = yield* Effect.result(applyUntrustedArgument(storage.put, storage, [A, null]))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.put' })
      }
      expect(yield* storage.get(A)).toStrictEqual(Option.none())
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('rejects null and blank batch keys instead of returning Option.none', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      for (const keys of [[null], ['']]) {
        const result = yield* Effect.result(applyUntrustedArgument(storage.readBatch, storage, [keys]))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.readBatch' })
        }
      }
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('rejects sparse and undefined batch arrays without changing stored values', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(A, envelope({ original: true }))
      const malformedInputs: ReadonlyArray<unknown> = [new Array<unknown>(1), [undefined]]

      for (const input of malformedInputs) {
        const commitError = yield* Effect.flip(applyUntrustedArgument(storage.commitBatch, storage, [input]))
        expect(commitError).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.commitBatch' })

        const readError = yield* Effect.flip(applyUntrustedArgument(storage.readBatch, storage, [input]))
        expect(readError).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.readBatch' })
      }

      expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ original: true })))
      expect(yield* storage.get(SaveKey('missing'))).toStrictEqual(Option.none())
      expect(yield* storage.keys).toStrictEqual([A])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('rejects malformed batch array shapes without invoking accessors', () =>
    Effect.gen(function* () {
      let accessorRead = false
      const symbolOnly = new Array<unknown>(1)
      Object.defineProperty(symbolOnly, Symbol('extra'), { value: 'not an index', enumerable: true })
      const negativeIndex = new Array<unknown>(1)
      Object.defineProperty(negativeIndex, '-1', { value: 'not an index', enumerable: true })
      const accessorEntry = new Array<unknown>(1)
      Object.defineProperty(accessorEntry, '0', {
        get: () => {
          accessorRead = true
          return 'not a data entry'
        },
        enumerable: true,
      })
      const invalidLength = new Proxy([], {
        getOwnPropertyDescriptor: (target, property) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
          if (property === 'length' && descriptor !== undefined) {
            return { ...descriptor, value: Number.NaN }
          }
          return descriptor
        },
      })
      const unreadableShape = new Proxy([], {
        ownKeys: () => {
          throw new Error('batch keys could not be read')
        },
      })
      const malformedInputs: ReadonlyArray<unknown> = [
        null,
        symbolOnly,
        negativeIndex,
        accessorEntry,
        invalidLength,
        unreadableShape,
      ]

      const storage = yield* StoragePort
      for (const input of malformedInputs) {
        const commitError = yield* Effect.flip(applyUntrustedArgument(storage.commitBatch, storage, [input]))
        expect(commitError).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.commitBatch' })
        const readError = yield* Effect.flip(applyUntrustedArgument(storage.readBatch, storage, [input]))
        expect(readError).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.readBatch' })
      }
      expect(accessorRead).toBe(false)
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('does not match an expected envelope when the key is absent', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const result = yield* Effect.result(storage.commitBatch([
        { _tag: 'Put', key: A, envelope: envelope({ next: true }), expected: Option.some(envelope({ old: true })) },
      ]))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: 'StorageError',
          operation: 'in-memory.commitBatch:conflict',
          key: A,
        })
      }
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('rejects malformed expected options and mutation tags without changing stored values', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(A, envelope({ original: true }))

      const nullExpected = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
        { _tag: 'Put', key: A, envelope: envelope({ replacement: true }), expected: null },
      ]]))
      const undefinedExpected = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
        { _tag: 'Put', key: A, envelope: envelope({ replacement: true }), expected: undefined },
      ]]))
      const invalidEnvelope = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
        { _tag: 'Put', key: A, envelope: null },
      ]]))
      expect(Result.isFailure(nullExpected)).toBe(true)
      expect(Result.isFailure(undefinedExpected)).toBe(true)
      expect(Result.isFailure(invalidEnvelope)).toBe(true)
      if (Result.isFailure(nullExpected)) {
        expect(nullExpected.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.commitBatch' })
      }
      expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ original: true })))

      const unknownTag = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
        { _tag: 'Rename', key: A },
      ]]))

      const malformedEntry = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[42]]))
      const blankMutationKey = yield* Effect.result(applyUntrustedArgument(storage.commitBatch, storage, [[
        { _tag: 'Put', key: '', envelope: envelope({ replacement: true }) },
      ]]))
      const tagFailure = new Error('mutation tag could not be read')
      const unreadableTag = Object.defineProperty({}, '_tag', {
        get: () => {
          throw tagFailure
        },
      })
      const unreadableMutation = yield* Effect.result(
        applyUntrustedArgument(storage.commitBatch, storage, [[unreadableTag]]),
      )

      expect(Result.isFailure(unknownTag)).toBe(true)
      if (Result.isFailure(unknownTag)) {
        expect(unknownTag.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.commitBatch' })
      }
      for (const result of [malformedEntry, blankMutationKey, unreadableMutation]) {
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.commitBatch' })
        }
      }
      if (Result.isFailure(unreadableMutation)) expect(unreadableMutation.failure.cause).toBe(tagFailure)
      expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ original: true })))
      expect(yield* storage.keys).toStrictEqual([A])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('uses each mutation field snapshot once when committing a batch', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      let tagReads = 0
      const mutation = {
        get _tag(): 'Put' {
          tagReads += 1
          if (tagReads > 1) throw new Error('mutation tag was read more than once')
          return 'Put'
        },
        key: A,
        envelope: envelope({ snapshot: true }),
      }

      const result = yield* Effect.result(storage.commitBatch([mutation]))
      expect(result).toStrictEqual(Result.succeed(undefined))
      expect(tagReads).toBe(1)
      expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ snapshot: true })))
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('propagates canonicalization failures from expected snapshots', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      yield* storage.put(A, envelope({ current: true }))
      const cyclicPayload: { self?: unknown } = {}
      cyclicPayload.self = cyclicPayload
      const expectedSnapshot = { ...envelope({ expected: true }), payload: cyclicPayload }
      const error = yield* Effect.flip(storage.commitBatch([
        { _tag: 'Put', key: A, envelope: envelope({ replacement: true }), expected: Option.some(expectedSnapshot) },
      ]))

      expect(error).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.commitBatch', key: A })
      expect(yield* storage.get(A)).toStrictEqual(Option.some(envelope({ current: true })))
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )

  effect('maps envelope decoding and structured-clone throws to StorageError', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const decodeFailure = new Error('envelope could not be inspected')
      const unreadableEnvelope = new Proxy(envelope({ n: 1 }), {
        get: (target, property, receiver) => {
          if (property === 'format') throw decodeFailure
          return Reflect.get(target, property, receiver)
        },
      })
      const decodeResult = yield* Effect.result(
        applyUntrustedArgument(storage.put, storage, [A, unreadableEnvelope]),
      )
      expect(Result.isFailure(decodeResult)).toBe(true)
      if (Result.isFailure(decodeResult)) {
        expect(decodeResult.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.put' })
      }

      const payloadProxy = new Proxy({ n: 1 }, {})
      const envelopeWithProxyPayload = { ...envelope({ n: 1 }), payload: payloadProxy }
      const cloneResult = yield* Effect.result(
        applyUntrustedArgument(storage.put, storage, [A, envelopeWithProxyPayload]),
      )
      expect(Result.isFailure(cloneResult)).toBe(true)
      if (Result.isFailure(cloneResult)) {
        expect(cloneResult.failure).toMatchObject({ _tag: 'StorageError', operation: 'in-memory.put' })
      }

      expect(yield* storage.get(A)).toStrictEqual(Option.none())
      expect(yield* storage.keys).toStrictEqual([])
    }).pipe(Effect.provide(InMemoryStorageLayer)),
  )
})

describe('SaveKey', () => {
  effect('rejects a blank key, which several backends accept and then cannot enumerate', () =>
    Effect.sync(() => {
      expect(() => SaveKey('')).toThrow()
      expect(() => SaveKey('   ')).toThrow()
      expect(SaveKey('world-1/chunk/0:0')).toBe('world-1/chunk/0:0')
    }),
  )
})

describe('failingStorageLayer', () => {
  effect('fails writes with a StorageError naming the operation and key', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort
      const error = yield* Effect.flip(storage.put(A, envelope({})))

      expect(error._tag).toBe('StorageError')
      expect(error.operation).toBe('quota-exceeded')
      expect(error.message).toContain('alpha')
    }).pipe(
      Effect.provide(failingStorageLayer(Result.getOrThrow(StorageOperation.result('quota-exceeded')))),
    ),
  )

  effect('fails every other method the same way, each naming the operation', () =>
    Effect.gen(function* () {
      const storage = yield* StoragePort

      const get = yield* Effect.flip(storage.get(A))
      const remove = yield* Effect.flip(storage.remove(A))
      const commitBatch = yield* Effect.flip(storage.commitBatch([{ _tag: 'Remove', key: A }]))
      const readBatch = yield* Effect.flip(storage.readBatch([A]))

      for (const error of [get, remove, commitBatch, readBatch]) {
        expect(error._tag).toBe('StorageError')
        expect(error.operation).toBe('unavailable')
      }
      // `get` and `remove` are keyed like `put`; `commitBatch` and `readBatch`
      // are not, the same asymmetry `StorageService`'s own shape has.
      expect(get.key).toBe('alpha')
      expect(remove.key).toBe('alpha')
      expect(commitBatch.key).toBeUndefined()
      expect(readBatch.key).toBeUndefined()
    }).pipe(
      Effect.provide(failingStorageLayer(Result.getOrThrow(StorageOperation.result('unavailable')))),
    ),
  )
})

describe('StorageError.message', () => {
  effect('omits the key clause when no key is involved', () =>
    Effect.sync(() => {
      // The other half of the "fails writes ... naming the operation and key"
      // assertion above: `put`'s error names its key, but `commitBatch` and
      // `readBatch` fail with no key at all, and the message getter has a
      // ternary specifically for that case.
      expect(new StorageError({ operation: 'indexeddb.commitBatch' }).message).toBe(
        'storage operation "indexeddb.commitBatch" failed',
      )
    }),
  )
})
