import { Clock, Effect, Option, Result, Schedule, Schema } from 'effect'
import { fileURLToPath } from 'node:url'
import {
  decodeSave,
  defineFormat,
  encodeSave,
  makeInMemoryStorage,
  SaveKey,
  saveDurably,
  sealSaveEnvelope,
  StoragePort,
  validateSaveEnvelope,
  type SaveEnvelope,
  type SaveFormat,
} from '../index.js'

const Chunk = Schema.Struct({
  x: Schema.Number,
  z: Schema.Number,
  blocks: Schema.Array(Schema.Number),
})

const World = Result.getOrThrow(defineFormat({
  name: 'mc-save/benchmark/world',
  version: 1,
  schema: Schema.Struct({
    dimension: Schema.String,
    chunks: Schema.Array(Chunk),
    entities: Schema.Array(Schema.Struct({ id: Schema.String, health: Schema.Number })),
  }),
}))

const world = {
  dimension: 'overworld',
  chunks: Array.from({ length: 64 }, (_, index) => ({
    x: index % 8,
    z: Math.floor(index / 8),
    blocks: Array.from({ length: 16_384 }, (__, block) => (block + index) % 256),
  })),
  entities: Array.from({ length: 512 }, (_, index) => ({ id: `entity-${String(index)}`, health: 20 })),
}

const key = SaveKey('benchmark-world')
const previous = SaveKey('benchmark-world::previous')

const checkpointPair = (
  batch: ReadonlyArray<Option.Option<SaveEnvelope>>,
): Result.Result<readonly [Option.Option<SaveEnvelope>, Option.Option<SaveEnvelope>], TypeError> => {
  if (batch.length !== 2) return Result.fail(new TypeError('storage returned an incomplete checkpoint batch'))
  const latest = batch[0]
  const old = batch[1]
  if (!Option.isOption(latest) || !Option.isOption(old)) {
    return Result.fail(new TypeError('storage returned an invalid checkpoint option'))
  }
  return Result.succeed([latest, old])
}

const baselineSave = <A, I>(format: SaveFormat<A, I>, value: A) =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const [latest, old] = yield* Effect.fromResult(checkpointPair(yield* storage.readBatch([key, previous])))
    const validateStored = (envelope: SaveEnvelope) =>
      validateSaveEnvelope(envelope).pipe(Effect.flatMap((valid) => decodeSave(format, valid)))
    const latestGood = Option.isSome(latest)
      ? Option.some(yield* validateStored(latest.value).pipe(Effect.as(latest.value)))
      : Option.none<SaveEnvelope>()
    if (Option.isSome(old)) yield* validateStored(old.value)
    const encoded = yield* encodeSave(format, value)
    const sealed = yield* Effect.fromResult(sealSaveEnvelope(encoded))
    yield* validateSaveEnvelope(sealed)
    yield* storage.commitBatch(
      Option.isSome(latestGood)
        ? [
            { _tag: 'Put' as const, key: previous, envelope: latestGood.value },
            { _tag: 'Put' as const, key, envelope: sealed },
          ]
        : [{ _tag: 'Put' as const, key, envelope: sealed }],
    )
  })

const measure = (run: Effect.Effect<void, unknown, never>, iterations: number): Effect.Effect<number, unknown, never> =>
  Effect.gen(function* () {
    const started = yield* Clock.monotonicTimeNanos
    yield* Effect.repeat(run, Schedule.recurs(iterations - 1))
    const elapsedNanos = (yield* Clock.monotonicTimeNanos) - started
    return Number(elapsedNanos) / 1_000_000 / iterations
  })

type BenchmarkResult = {
  readonly chunks: number
  readonly blocks: number
  readonly baselineMs: number
  readonly currentMs: number
  readonly speedup: number
}

const benchmark = <A, I>(
  format: SaveFormat<A, I>,
  value: A,
  summary: Pick<BenchmarkResult, 'chunks' | 'blocks'>,
  iterations: number,
): Effect.Effect<BenchmarkResult, unknown, never> =>
  Effect.gen(function* () {
    const storage = yield* makeInMemoryStorage
    const current = saveDurably(format, key, value).pipe(Effect.provideService(StoragePort, storage))
    const baseline = baselineSave(format, value).pipe(Effect.provideService(StoragePort, storage))

    yield* baseline
    yield* current
    yield* current
    const baselineMs = yield* measure(baseline, iterations)
    const currentMs = yield* measure(current, iterations)

    return { ...summary, baselineMs, currentMs, speedup: baselineMs / currentMs }
  })

export const runDurableSaveBenchmark = <A, I>(
  shouldRun: boolean,
  format: SaveFormat<A, I>,
  value: A,
  summary: Pick<BenchmarkResult, 'chunks' | 'blocks'>,
  iterations: number,
): Effect.Effect<void, unknown, never> => {
  if (!shouldRun) return Effect.void

  return Effect.gen(function* () {
    const result = yield* benchmark(format, value, summary, iterations)
    // Benchmark output is consumed directly by release verification.
    yield* Effect.sync(() => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result))
    })
  })
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
await Effect.runPromise(
  runDurableSaveBenchmark(invokedDirectly, World, world, {
    chunks: world.chunks.length,
    blocks: 64 * 16_384,
  }, 5),
)
