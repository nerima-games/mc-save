import { describe, expect, it, vi } from 'vitest'
import { isMinecraftNbtDocument } from '../src/domain/minecraft-nbt-validation.js'

type Tag = Record<string, unknown>

const byte = (value: number): Tag => ({ type: 'byte', value })
const compound = (entries: ReadonlyArray<readonly [string, Tag]>): Tag => ({ type: 'compound', entries })
const doc = (root: Tag, name = '') => ({ name, root })

// Every case below nests the tag under test as a single compound entry, since isMinecraftNbtDocument
// only accepts a compound root — the internal 'list'/'string'/nested-compound branches are otherwise
// unreachable from the public entry point.
const wrap = (entry: Tag): unknown => doc(compound([['entry', entry]]))

describe('Minecraft NBT document validation, low-level boundary', () => {
  it('accepts a minimal valid document', () => {
    expect(isMinecraftNbtDocument(doc(compound([])))).toBe(true)
  })

  it('rejects a list whose elementType is not a known NBT tag type', () => {
    expect(isMinecraftNbtDocument(wrap({ type: 'list', elementType: 'bogus', values: [] }))).toBe(false)
  })

  it('accepts a tag whose own prototype is null', () => {
    const nullPrototypeByte: Tag = Object.assign(Object.create(null) as Tag, { type: 'byte', value: 1 })
    expect(isMinecraftNbtDocument(wrap(nullPrototypeByte))).toBe(true)
  })

  it('rejects a tag carrying the right key count but a wrongly named key', () => {
    expect(isMinecraftNbtDocument(wrap({ type: 'byte', notValue: 1 }))).toBe(false)
  })

  it('rejects a list whose values field is not an array at all', () => {
    expect(isMinecraftNbtDocument(wrap({ type: 'list', elementType: 'byte', values: {} }))).toBe(false)
  })

  it('rejects a list whose values array has a non-Array, non-null prototype', () => {
    const withCustomPrototype: unknown[] = [byte(1)]
    Object.setPrototypeOf(withCustomPrototype, { extra: true })
    expect(isMinecraftNbtDocument(wrap({ type: 'list', elementType: 'byte', values: withCustomPrototype }))).toBe(
      false,
    )
  })

  it('rejects a byteArray value that is not a Uint8Array or has a foreign prototype', () => {
    expect(isMinecraftNbtDocument(wrap({ type: 'byteArray', value: [1, 2] }))).toBe(false)
    const derivedBytes = new (class extends Uint8Array {})([1, 2])
    expect(isMinecraftNbtDocument(wrap({ type: 'byteArray', value: derivedBytes }))).toBe(false)
  })

  it('rejects a list declared empty-typed ("end") but carrying values', () => {
    expect(isMinecraftNbtDocument(wrap({ type: 'list', elementType: 'end', values: [byte(1)] }))).toBe(false)
  })

  it('rejects a list whose values are not a dense array', () => {
    const sparse = new Array(1) as unknown[]
    expect(isMinecraftNbtDocument(wrap({ type: 'list', elementType: 'byte', values: sparse }))).toBe(false)
  })

  it('rejects a list entry whose declared type does not match elementType', () => {
    expect(
      isMinecraftNbtDocument(
        wrap({ type: 'list', elementType: 'byte', values: [{ type: 'short', value: 1 }] }),
      ),
    ).toBe(false)
  })

  it('accepts a well-formed non-empty list nested inside a compound', () => {
    expect(isMinecraftNbtDocument(wrap({ type: 'list', elementType: 'byte', values: [byte(1), byte(2)] }))).toBe(
      true,
    )
  })

  it('rejects a compound whose entries are not a dense array', () => {
    expect(isMinecraftNbtDocument(wrap({ type: 'compound', entries: new Array(1) }))).toBe(false)
  })

  it('rejects a compound entry that is not a [name, tag] pair', () => {
    expect(isMinecraftNbtDocument(wrap({ type: 'compound', entries: [['only-one-element']] }))).toBe(false)
    expect(isMinecraftNbtDocument(wrap({ type: 'compound', entries: [['a', byte(1), byte(2)]] }))).toBe(false)
  })

  it('rejects an array value carrying a non-index enumerable own key', () => {
    const withExtraKey = [byte(1)] as unknown[] & { extra?: boolean }
    withExtraKey.extra = true
    expect(isMinecraftNbtDocument(wrap({ type: 'list', elementType: 'byte', values: withExtraKey }))).toBe(false)
  })

  it('rejects an array value carrying a non-enumerable index property', () => {
    const withHiddenIndex = [byte(1)] as unknown[]
    Object.defineProperty(withHiddenIndex, '0', { value: byte(1), enumerable: false, configurable: true })
    expect(isMinecraftNbtDocument(wrap({ type: 'list', elementType: 'byte', values: withHiddenIndex }))).toBe(false)
  })

  it('rejects a document once nesting exceeds the maximum validation depth', () => {
    const MAX_DEPTH = 512
    // Root itself is depth 1, so a chain of MAX_DEPTH nested compounds beyond the root exceeds the limit.
    let tag: Tag = compound([])
    for (let level = 0; level < MAX_DEPTH; level += 1) {
      tag = compound([['nested', tag]])
    }
    expect(isMinecraftNbtDocument(doc(tag))).toBe(false)
  })

  it('accepts a document nested exactly up to the maximum validation depth', () => {
    const MAX_DEPTH = 512
    // Root sits at depth 1, so MAX_DEPTH - 1 wraps places the innermost tag at depth MAX_DEPTH exactly,
    // the boundary the `depth > MAX_NBT_VALIDATION_DEPTH` check must still accept.
    let tag: Tag = compound([])
    for (let level = 0; level < MAX_DEPTH - 1; level += 1) {
      tag = compound([['nested', tag]])
    }
    expect(isMinecraftNbtDocument(doc(tag))).toBe(true)
  })

  it('guards the defensive modified UTF-8 encode failure path for names and strings', async () => {
    const SENTINEL = '__force-modified-utf8-failure__'
    vi.resetModules()
    vi.doMock('../src/domain/minecraft-utf8.js', async () => {
      const actual =
        await vi.importActual<typeof import('../src/domain/minecraft-utf8.js')>('../src/domain/minecraft-utf8.js')
      return {
        ...actual,
        encodeModifiedUtf8: (value: string) => {
          if (value === SENTINEL) throw new Error('forced modified UTF-8 failure')
          return actual.encodeModifiedUtf8(value)
        },
      }
    })
    try {
      const { isMinecraftNbtDocument: mockedIsMinecraftNbtDocument } = await import(
        '../src/domain/minecraft-nbt-validation.js'
      )
      expect(mockedIsMinecraftNbtDocument(doc(compound([]), SENTINEL))).toBe(false)
      expect(mockedIsMinecraftNbtDocument(wrap({ type: 'string', value: SENTINEL }))).toBe(false)
    } finally {
      vi.doUnmock('../src/domain/minecraft-utf8.js')
      vi.resetModules()
    }
  })
})
