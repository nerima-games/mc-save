import { Effect, Option, Result, Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'

const faultMode = vi.hoisted(() => ({ shortBatch: false }))

vi.doMock('../src/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/index.js')>('../src/index.js')
  const storage = await Effect.runPromise(actual.makeInMemoryStorage)
  const malformedStorage = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'readBatch') {
        return () => {
          const batch = faultMode.shortBatch ? [Option.none()] : [Option.none(), Option.none()]
          if (!faultMode.shortBatch) Reflect.set(batch, 1, null)
          return Effect.succeed(batch)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return { ...actual, makeInMemoryStorage: Effect.succeed(malformedStorage) }
})

const { runDurableSaveBenchmark } = await import('../src/entrypoints/bench-durable-save.js')

const Format = Result.getOrThrow((await import('../src/index.js')).defineFormat({
  name: 'mc-save/test/benchmark-checkpoint',
  version: 1,
  schema: Schema.Struct({ value: Schema.Number }),
}))

describe('durable-save benchmark checkpoint boundary', () => {
  it('fails when storage returns a malformed Option instead of treating it as absent', async () => {
    await expect(
      Effect.runPromise(runDurableSaveBenchmark(true, Format, { value: 1 }, { chunks: 1, blocks: 1 }, 1)),
    ).rejects.toThrow('storage returned an invalid checkpoint option')
  })

  it('fails when storage returns fewer checkpoint entries than requested', async () => {
    faultMode.shortBatch = true

    await expect(
      Effect.runPromise(runDurableSaveBenchmark(true, Format, { value: 1 }, { chunks: 1, blocks: 1 }, 1)),
    ).rejects.toThrow('storage returned an incomplete checkpoint batch')
  })
})
