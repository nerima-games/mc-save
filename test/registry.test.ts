import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { Effect, Either, Option, Schema } from 'effect'
import { DuplicateFormatError } from '../src/domain/errors.js'
import { defineFormat } from '../src/domain/format.js'
import {
  describeRegistry,
  emptyRegistry,
  lookupFormat,
  registerFormat,
  registerFormats,
  type RegisteredSaveFormat,
} from '../src/domain/registry.js'

const formatNamed = (name: string, version = 1): RegisteredSaveFormat =>
  defineFormat({
    name,
    version,
    schema: Schema.Unknown,
  })

describe('registerFormat', () => {
  effect('adds a format to an empty registry, findable by name afterwards', () =>
    Effect.sync(() => {
      const alpha = formatNamed('mc-save/test/alpha')
      const result = registerFormat(emptyRegistry, alpha)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(lookupFormat(result.right, 'mc-save/test/alpha')).toStrictEqual(Option.some(alpha))
      }
    }),
  )

  effect('refuses a second format registered under a name already taken', () =>
    Effect.sync(() => {
      const first = formatNamed('mc-save/test/dup')
      const second = formatNamed('mc-save/test/dup', 2)
      const registry = registerFormat(emptyRegistry, first)
      if (Either.isLeft(registry)) throw new Error('setup: first registration unexpectedly failed')

      const result = registerFormat(registry.right, second)

      expect(result).toStrictEqual(Either.left(new DuplicateFormatError({ format: 'mc-save/test/dup' })))
    }),
  )

  effect('does not mutate the registry it was given', () =>
    Effect.sync(() => {
      // The header says registration "never mutates in place and never
      // silently overwrites" — worth its own assertion since a mutating bug
      // here would still pass every other test in this file.
      const alpha = formatNamed('mc-save/test/alpha')
      const result = registerFormat(emptyRegistry, alpha)

      expect(Either.isRight(result)).toBe(true)
      expect(emptyRegistry.size).toBe(0)
    }),
  )
})

describe('registerFormats', () => {
  effect('registers every format when none collide', () =>
    Effect.sync(() => {
      const alpha = formatNamed('mc-save/test/alpha')
      const beta = formatNamed('mc-save/test/beta')

      const result = registerFormats(emptyRegistry, [alpha, beta])

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(lookupFormat(result.right, 'mc-save/test/alpha')).toStrictEqual(Option.some(alpha))
        expect(lookupFormat(result.right, 'mc-save/test/beta')).toStrictEqual(Option.some(beta))
      }
    }),
  )

  effect('stops at the first duplicate, via Either.flatMap short-circuiting the reduce', () =>
    Effect.sync(() => {
      const alpha = formatNamed('mc-save/test/alpha')
      const alphaAgain = formatNamed('mc-save/test/alpha', 2)
      const gamma = formatNamed('mc-save/test/gamma')

      const result = registerFormats(emptyRegistry, [alpha, alphaAgain, gamma])

      // Not just "some Left": the specific duplicate, and never gamma, which
      // is only distinguishable from a fully-successful run by naming it.
      expect(result).toStrictEqual(Either.left(new DuplicateFormatError({ format: 'mc-save/test/alpha' })))
    }),
  )
})

describe('lookupFormat', () => {
  effect('finds a registered format', () =>
    Effect.sync(() => {
      const alpha = formatNamed('mc-save/test/alpha')
      const registry = registerFormat(emptyRegistry, alpha)
      if (Either.isLeft(registry)) throw new Error('setup: registration unexpectedly failed')

      expect(lookupFormat(registry.right, 'mc-save/test/alpha')).toStrictEqual(Option.some(alpha))
    }),
  )

  effect('reports an unregistered name as none', () =>
    Effect.sync(() => {
      expect(lookupFormat(emptyRegistry, 'mc-save/test/never-registered')).toStrictEqual(Option.none())
    }),
  )
})

describe('describeRegistry', () => {
  effect('is empty for an empty registry', () =>
    Effect.sync(() => {
      expect(describeRegistry(emptyRegistry)).toStrictEqual([])
    }),
  )

  effect('sorts every registered format by name, regardless of registration order', () =>
    Effect.sync(() => {
      // Registered out of alphabetical order on purpose: the comparator at the
      // bottom of describeRegistry is what this test is actually exercising.
      const zulu = formatNamed('mc-save/test/zulu', 3)
      const alpha = formatNamed('mc-save/test/alpha', 1)
      const mike = formatNamed('mc-save/test/mike', 2)

      const registry = registerFormats(emptyRegistry, [zulu, alpha, mike])
      if (Either.isLeft(registry)) throw new Error('setup: registration unexpectedly failed')

      expect(describeRegistry(registry.right)).toStrictEqual([
        { name: 'mc-save/test/alpha', version: 1 },
        { name: 'mc-save/test/mike', version: 2 },
        { name: 'mc-save/test/zulu', version: 3 },
      ])
    }),
  )

  effect('the comparator does not reorder two equally-named entries', () =>
    Effect.sync(() => {
      // `registerFormat`/`registerFormats` enforce name-uniqueness (a Map keyed
      // by name), so this state cannot arise through the module's own public
      // API — the comparator's equal-name arm (`left.name === right.name`) is
      // otherwise never taken. `FormatRegistry` is a plain `ReadonlyMap`, not an
      // opaque type, so `describeRegistry` still has to behave sensibly if a
      // caller builds one another way (e.g. composing two registries' entries
      // under fresh keys), and that is exactly what this constructs.
      const tiedName = 'mc-save/test/tied'
      const first = formatNamed(tiedName, 1)
      const second = formatNamed(tiedName, 1)
      const tied = new Map([
        ['slot-a', first],
        ['slot-b', second],
      ])

      const described = describeRegistry(tied)

      expect(described).toStrictEqual([
        { name: tiedName, version: 1 },
        { name: tiedName, version: 1 },
      ])
    }),
  )
})

describe('DuplicateFormatError', () => {
  effect('renders a message naming the format that collided', () =>
    Effect.sync(() => {
      expect(new DuplicateFormatError({ format: 'x' }).message).toBe('save format "x" is already registered')
    }),
  )
})
