import { describe, expect } from 'vitest'
import { effect } from './support/effect-test.js'
import { applyUntrustedArgument } from './support/apply-untrusted-argument.js'
import { Effect, Result, Schema } from 'effect'
import { decodeSave, defineFormat as defineFormatResult, encodeSave } from '../src/domain/format.js'
import { JsonFieldName } from '../src/domain/brand-types.js'
import {
  encodeUndefinedAsNull,
  restoreNullAsUndefined,
  undefinedFieldsAsNull,
} from '../src/domain/optional-fields.js'

const noteField = Result.getOrThrow(JsonFieldName.result('note'))

type Widget = {
  readonly id: string
  readonly note: string | undefined
  readonly tags: ReadonlyArray<string>
}

const defineFormat = <A, I>(spec: {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<A, I>
}) => Result.getOrThrow(defineFormatResult(spec))
const WidgetSchema = undefinedFieldsAsNull(
  Schema.Struct({
    id: Schema.String,
    note: Schema.UndefinedOr(Schema.String),
    tags: Schema.Array(Schema.String),
  }),
  [noteField],
)

const WIDGET_FORMAT = defineFormat({
  name: 'mc-save/test/widget',
  version: 1,
  schema: WidgetSchema,
})

describe('undefinedFieldsAsNull', () => {
  const OptionalUnknownSchema = undefinedFieldsAsNull(Schema.Unknown, [noteField])

  effect('round-trips a present undefined field through the real integrity path', () =>
    Effect.gen(function* () {
      // Without the swap this file demonstrates, `encodeSave` would fail here:
      // `canonicalize` (exercised by `encodeSave`'s own `validateEncodedPayload`
      // step) rejects a bare `undefined` anywhere in the encoded payload.
      const original: Widget = { id: 'a', note: undefined, tags: ['x'] }

      const draft = yield* encodeSave(WIDGET_FORMAT, original)
      expect(draft.payload).toStrictEqual({ id: 'a', note: null, tags: ['x'] })

      const restored = yield* decodeSave(WIDGET_FORMAT, draft)
      expect(restored).toStrictEqual(original)
    }),
  )

  effect('round-trips a present field unchanged', () =>
    Effect.gen(function* () {
      const original: Widget = { id: 'a', note: 'hello', tags: [] }

      const draft = yield* encodeSave(WIDGET_FORMAT, original)
      expect(draft.payload).toStrictEqual({ id: 'a', note: 'hello', tags: [] })

      const restored = yield* decodeSave(WIDGET_FORMAT, draft)
      expect(restored).toStrictEqual(original)
    }),
  )

  effect('surfaces optional-field transformation failures through both schema directions', () =>
    Effect.sync(() => {
      const value = { note: undefined, [Symbol('extra')]: true }

      expect(Result.isFailure(Schema.decodeUnknownResult(OptionalUnknownSchema)(value))).toBe(true)
      expect(Result.isFailure(Schema.encodeUnknownResult(OptionalUnknownSchema)(value))).toBe(true)
    }),
  )

  effect('preserves array and Uint8Array codecs without converting them to records', () =>
    Effect.sync(() => {
      const values = [['item'], new Uint8Array([1, 2, 255])]

      for (const value of values) {
        const decoded = Schema.decodeUnknownResult(OptionalUnknownSchema)(value)
        const encoded = Schema.encodeUnknownResult(OptionalUnknownSchema)(value)

        expect(Result.isSuccess(decoded)).toBe(true)
        expect(Result.isSuccess(encoded)).toBe(true)
        if (Result.isSuccess(decoded)) expect(decoded.success).toBe(value)
        if (Result.isSuccess(encoded)) expect(encoded.success).toBe(value)
      }
    }),
  )

  effect('rejects field names that fail brand validation in both schema directions', () =>
    Effect.sync(() => {
      const invalidFields = [null]
      const restoreInvalidFields = applyUntrustedArgument(
        restoreNullAsUndefined,
        undefined,
        [invalidFields],
      )
      const encodeInvalidFields = applyUntrustedArgument(
        encodeUndefinedAsNull,
        undefined,
        [invalidFields],
      )

      expect(Result.isFailure(restoreInvalidFields({ note: null }))).toBe(true)
      expect(Result.isFailure(encodeInvalidFields({ note: undefined }))).toBe(true)
    }),
  )

  effect('returns a schema issue when the field-name iterable cannot be read', () =>
    Effect.sync(() => {
      const unreadableFields = {
        [Symbol.iterator]: () => {
          throw new Error('unreadable field names')
        },
      }
      const restoreUnreadableFields = applyUntrustedArgument(
        restoreNullAsUndefined,
        undefined,
        [unreadableFields],
      )
      const encodeUnreadableFields = applyUntrustedArgument(
        encodeUndefinedAsNull,
        undefined,
        [unreadableFields],
      )

      const decoded = restoreUnreadableFields({ note: null })
      const encoded = encodeUnreadableFields({ note: undefined })

      expect(Result.isFailure(decoded)).toBe(true)
      expect(Result.isFailure(encoded)).toBe(true)
    }),
  )

  effect('rejects explicit null in a domain field typed as string or undefined', () =>
    Effect.sync(() => {
      const result = Schema.encodeUnknownResult(WidgetSchema)({ id: 'a', note: null, tags: [] })

      expect(Result.isFailure(result)).toBe(true)
    }),
  )
})

describe('restoreNullAsUndefined', () => {
  const restore = (value: unknown) => Result.getOrThrow(restoreNullAsUndefined([noteField])(value))

  effect('leaves a non-record value untouched', () =>
    Effect.sync(() => {
      expect(restore(null)).toBe(null)
      expect(restore('x')).toBe('x')
    }),
  )

  effect('leaves an absent field absent rather than inventing it', () =>
    Effect.sync(() => {
      expect(restore({ id: 'a' })).toStrictEqual({ id: 'a' })
    }),
  )

  effect('turns a stored null into undefined for exactly the named field', () =>
    Effect.sync(() => {
      expect(restore({ id: 'a', note: null, other: null })).toStrictEqual({
        id: 'a',
        note: undefined,
        other: null,
      })
    }),
  )

  effect('leaves a non-null value at the named field untouched', () =>
    Effect.sync(() => {
      expect(restore({ id: 'a', note: 'hi' })).toStrictEqual({ id: 'a', note: 'hi' })
    }),
  )

  effect('restores a non-enumerable own optional field', () =>
    Effect.sync(() => {
      const value = { id: 'a' }
      Object.defineProperty(value, 'note', { value: null, enumerable: false })

      expect(restore(value)).toStrictEqual({ id: 'a', note: undefined })
    }),
  )

  effect('rejects symbol-keyed input', () =>
    Effect.sync(() => {
      const value = { id: 'a', [Symbol('extra')]: true }

      expect(Result.isFailure(restoreNullAsUndefined([noteField])(value))).toBe(true)
    }),
  )

  effect('returns a typed failure when an input getter throws', () =>
    Effect.sync(() => {
      const value = Object.defineProperty({ id: 'a' }, 'note', {
        enumerable: true,
        get: () => {
          throw new Error('unreadable optional field')
        },
      })

      expect(Result.isFailure(restoreNullAsUndefined([noteField])(value))).toBe(true)
    }),
  )
})

describe('encodeUndefinedAsNull', () => {
  const encode = (value: unknown) => Result.getOrThrow(encodeUndefinedAsNull([noteField])(value))

  effect('leaves a non-record value untouched', () =>
    Effect.sync(() => {
      expect(encode(null)).toBe(null)
      expect(encode('x')).toBe('x')
    }),
  )

  effect('leaves an absent field absent rather than inventing it', () =>
    Effect.sync(() => {
      expect(encode({ id: 'a' })).toStrictEqual({ id: 'a' })
    }),
  )

  effect('turns a present undefined into null for exactly the named field', () =>
    Effect.sync(() => {
      expect(encode({ id: 'a', note: undefined, other: undefined })).toStrictEqual({
        id: 'a',
        note: null,
        other: undefined,
      })
    }),
  )

  effect('leaves a defined value at the named field untouched', () =>
    Effect.sync(() => {
      expect(encode({ id: 'a', note: 'hi' })).toStrictEqual({ id: 'a', note: 'hi' })
    }),
  )

  effect('encodes a non-enumerable own optional field', () =>
    Effect.sync(() => {
      const value = { id: 'a' }
      Object.defineProperty(value, 'note', { value: undefined, enumerable: false })

      expect(encode(value)).toStrictEqual({ id: 'a', note: null })
    }),
  )

  effect('rejects symbol-keyed input', () =>
    Effect.sync(() => {
      const value = { id: 'a', [Symbol('extra')]: true }

      expect(Result.isFailure(encodeUndefinedAsNull([noteField])(value))).toBe(true)
    }),
  )

  effect('returns a typed failure when an input getter throws', () =>
    Effect.sync(() => {
      const value = Object.defineProperty({ id: 'a' }, 'note', {
        enumerable: true,
        get: () => {
          throw new Error('unreadable optional field')
        },
      })

      expect(Result.isFailure(encodeUndefinedAsNull([noteField])(value))).toBe(true)
    }),
  )
})
