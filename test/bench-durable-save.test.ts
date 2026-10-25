import { describe, expect, it, vi } from 'vitest'
import { Effect, Result, Schema } from 'effect'
import { defineFormat as defineFormatResult } from '../src/domain/format.js'
import {
  DurableSaveBenchmarkIterations,
  runDurableSaveBenchmark,
} from '../src/entrypoints/bench-durable-save.js'

const World = Result.getOrThrow(defineFormatResult({
  name: 'mc-save/test/benchmark-world',
  version: 1,
  schema: Schema.Struct({
    dimension: Schema.String,
    chunks: Schema.Array(Schema.Struct({ x: Schema.Number, z: Schema.Number, blocks: Schema.Array(Schema.Number) })),
    entities: Schema.Array(Schema.Struct({ id: Schema.String, health: Schema.Number })),
  }),
}))

const world = {
  dimension: 'overworld',
  chunks: [{ x: 0, z: 0, blocks: [1, 2] }],
  entities: [{ id: 'entity-1', health: 20 }],
}
const iterations = (value: number) => Result.getOrThrow(DurableSaveBenchmarkIterations.result(value))

describe('durable-save benchmark entrypoint', () => {
  it('does not run or print when imported outside its direct CLI invocation', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await Effect.runPromise(runDurableSaveBenchmark(false, World, world, { chunks: 1, blocks: 2 }, iterations(1)))
      expect(output).not.toHaveBeenCalled()
    } finally {
      output.mockRestore()
    }
  })

  it('runs both checkpoint paths with a small fixture and reports the measured summary', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await Effect.runPromise(runDurableSaveBenchmark(true, World, world, { chunks: 1, blocks: 2 }, iterations(2)))

      expect(output).toHaveBeenCalledTimes(1)
      const line = output.mock.calls[0]?.[0]
      if (typeof line !== 'string') throw new Error('benchmark did not print its result')

      const result = JSON.parse(line)
      expect(result).toMatchObject({ chunks: 1, blocks: 2 })
      expect(Number.isFinite(result.baselineMs)).toBe(true)
      expect(Number.isFinite(result.currentMs)).toBe(true)
      expect(Number.isFinite(result.speedup)).toBe(true)
    } finally {
      output.mockRestore()
    }
  })
})
