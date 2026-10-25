import { Effect, Option, Result, Schedule, Schema } from 'effect'
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
} from '../src/index.js'

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

const baselineSave = <A, I>(format: SaveFormat<A, I>, value: A) =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const [latest = Option.none(), old = Option.none()] = yield* storage.readBatch([key, previous])
    const validateStored = (envelope: SaveEnvelope) =>
      validateSaveEnvelope(envelope).pipe(Effect.flatMap((valid) => decodeSave(format, valid)))
    const latestGood = Option.isSome(latest)
      ? yield* validateStored(latest.value).pipe(Effect.as(latest.value), Effect.option)
      : Option.none<SaveEnvelope>()
    if (Option.isSome(old)) yield* validateStored(old.value).pipe(Effect.option)
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
    const started = performance.now()
    yield* Effect.repeat(run, Schedule.recurs(iterations - 1))
    return (performance.now() - started) / iterations
  })

const benchmark = Effect.gen(function* () {
  const storage = yield* makeInMemoryStorage
  const current = saveDurably(World, key, world).pipe(Effect.provideService(StoragePort, storage))
  const baseline = baselineSave(World, world).pipe(Effect.provideService(StoragePort, storage))

  yield* current
  yield* current
  const baselineMs = yield* measure(baseline, 5)
  const currentMs = yield* measure(current, 5)

  return { chunks: world.chunks.length, blocks: 64 * 16_384, baselineMs, currentMs, speedup: baselineMs / currentMs }
})

const result = await Effect.runPromise(benchmark)

// Benchmark output is consumed directly by release verification.
// eslint-disable-next-line no-console
console.log(JSON.stringify(result))
