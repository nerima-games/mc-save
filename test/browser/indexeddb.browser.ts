import { Effect, Option } from 'effect'
import { expect } from 'vitest'
import { indexedDbStorageLayer, makeIndexedDbStorage } from '../../src/domain/indexeddb-storage.js'
import { SaveKey } from '../../src/domain/save-key.js'
import { storagePortContract } from '../storage-port-contract.js'
import { effect } from '../support/effect-test.js'
import { sealedTestEnvelope } from '../support/save-envelope.js'

let databaseSequence = 0

storagePortContract('IndexedDB (Chromium)', () =>
  indexedDbStorageLayer({
    databaseName: `mc-save/browser/${databaseSequence++}`,
    factory: indexedDB,
  }),
)

effect('serializes compare-and-set commits across independent IndexedDB connections', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseName = `mc-save/browser/concurrency/${databaseSequence++}`
      const first = yield* makeIndexedDbStorage({ databaseName, factory: indexedDB })
      const second = yield* makeIndexedDbStorage({ databaseName, factory: indexedDB })
      const key = SaveKey('concurrency')
      const initial = sealedTestEnvelope('mc-save/test/browser-concurrency', 1, { value: 0 })
      const firstUpdate = sealedTestEnvelope('mc-save/test/browser-concurrency', 1, { value: 1 })
      const secondUpdate = sealedTestEnvelope('mc-save/test/browser-concurrency', 1, { value: 2 })

      yield* first.put(key, initial)
      const outcomes = yield* Effect.all(
        [
          first.commitBatch([{ _tag: 'Put', key, envelope: firstUpdate, expected: Option.some(initial) }]),
          second.commitBatch([{ _tag: 'Put', key, envelope: secondUpdate, expected: Option.some(initial) }]),
        ].map(Effect.either),
        { concurrency: 'unbounded' },
      )

      expect(outcomes.filter((outcome) => outcome._tag === 'Right')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome._tag === 'Left')).toHaveLength(1)

      const stored = yield* first.get(key)
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isSome(stored)) {
        expect([1, 2]).toContain((stored.value.payload as { readonly value: number }).value)
      }
    }),
  ),
)
