import { ChunkAxis } from '@nerima-games/mc-kernel'
import { describe, expect, it } from 'vitest'
import {
  ANVIL_CHUNK_COUNT,
  anvilRegion,
  type AnvilChunkRecord,
  type AnvilRegion,
  decodeMinecraftJavaSave,
  encodeMinecraftJavaSave,
  MinecraftJavaSaveError,
  nbtCompound,
  nbtDocument,
  nbtInt,
  nbtLong,
  nbtString,
  type MinecraftJavaSave,
  type MinecraftJavaSaveFile,
} from '../src/index.js'

const PLAYER_ID = '01234567-89ab-cdef-0123-456789abcdef'

const document = (name: string, marker: number) =>
  nbtDocument(
    name,
    nbtCompound([
      [
        'Data',
        nbtCompound([
          ['DataVersion', nbtInt(marker)],
          ['LastUpdate', nbtLong(BigInt(marker))],
        ]),
      ],
      ['Payload', nbtString(`official-save-fixture-${String(marker)}`)],
    ]),
  )

const regionWithChunk = (payload: Uint8Array, external = false): AnvilRegion => {
  const chunks: Array<AnvilChunkRecord | null> = new Array(ANVIL_CHUNK_COUNT).fill(null)
  chunks[0] = {
    localX: 0,
    localZ: 0,
    timestamp: 7,
    compression: 'none',
    payload,
    ...(external ? { external: true } : {}),
  }
  return anvilRegion(chunks)
}

const fixture = (): MinecraftJavaSave => ({
  level: document('Level', 1),
  levelBackup: document('Level', 2),
  sessionLock: 123n,
  icon: new Uint8Array([137, 80, 78, 71]),
  playerData: [{ playerId: PLAYER_ID, document: document('Player', 3) }],
  playerStats: [{ playerId: PLAYER_ID, value: { stats: { 'minecraft:jump': 4 } } }],
  playerAdvancements: [{ playerId: PLAYER_ID, value: { DataVersion: 4325, done: true } }],
  regions: [
    {
      dimension: 'example:moon',
      storage: 'entities',
      regionX: ChunkAxis(-1),
      regionZ: ChunkAxis(2),
      region: regionWithChunk(new Uint8Array([4, 5, 6]), true),
    },
    {
      dimension: 'overworld',
      storage: 'region',
      regionX: ChunkAxis(0),
      regionZ: ChunkAxis(0),
      region: regionWithChunk(new Uint8Array([1, 2, 3])),
    },
    {
      dimension: 'the_end',
      storage: 'poi',
      regionX: ChunkAxis(1),
      regionZ: ChunkAxis(-2),
      region: regionWithChunk(new Uint8Array([7, 8, 9])),
    },
  ],
  dataFiles: [
    { namespace: 'minecraft', name: 'ender_dragon_fight.dat', dimension: 'the_end', document: document('Data', 4) },
    { namespace: 'minecraft', name: 'raids.dat', document: document('Data', 5) },
    { namespace: 'example', name: 'moon/state.dat', dimension: 'example:moon', document: document('Data', 6) },
  ],
  worldClocks: [{ namespace: 'minecraft', id: 'day', value: { ticks: 12345, paused: false } }],
  structures: [{ namespace: 'minecraft', name: 'village/plains/houses/small_house_1', document: document('', 7) }],
  resourcePack: new Uint8Array([80, 75, 3, 4]),
  extraFiles: [
    { path: 'datapacks/example/pack.mcmeta', bytes: new Uint8Array([123, 125]) },
    { path: 'unknown.bin', bytes: new Uint8Array([10, 11]) },
  ],
})

const paths = (files: ReadonlyArray<MinecraftJavaSaveFile>): ReadonlyArray<string> => files.map((file) => file.path)

const findFile = (files: ReadonlyArray<MinecraftJavaSaveFile>, path: string): MinecraftJavaSaveFile => {
  const file = files.find((candidate) => candidate.path === path)
  if (file === undefined) throw new Error(`missing fixture file ${path}`)
  return file
}

const expectInvalidSave = (save: unknown, message: string) =>
  // @ts-expect-error -- `save` is deliberately shaped wrong by every caller to verify runtime rejection
  expect(encodeMinecraftJavaSave(save)).rejects.toThrow(message)

describe('Minecraft Java 26.1 world save boundary', () => {
  it('round-trips official world save categories and dimension storage', async () => {
    const source = fixture()
    const files = await encodeMinecraftJavaSave(source)

    expect(new Set(paths(files))).toEqual(
      new Set([
        'level.dat',
        'level.dat_old',
        'session.lock',
        'icon.png',
        'resourcepacks/resources.zip',
        `players/data/${PLAYER_ID}.dat`,
        `players/stats/${PLAYER_ID}.json`,
        `players/advancements/${PLAYER_ID}.json`,
        'dimensions/example/moon/entities/r.-1.2.mca',
        'dimensions/example/moon/entities/c.-32.64.mcc',
        'dimensions/minecraft/overworld/region/r.0.0.mca',
        'dimensions/minecraft/the_end/poi/r.1.-2.mca',
        'data/minecraft/raids.dat',
        'data/minecraft/world_clock/day.json',
        'dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat',
        'dimensions/example/moon/data/example/moon/state.dat',
        'generated/minecraft/structure/village/plains/houses/small_house_1.nbt',
        'datapacks/example/pack.mcmeta',
        'unknown.bin',
      ]),
    )
    expect(findFile(files, 'level.dat').bytes.byteLength).toBeGreaterThan(0)
    expect(findFile(files, `dimensions/example/moon/entities/c.-32.64.mcc`).bytes).toStrictEqual(
      new Uint8Array([4, 5, 6]),
    )

    const decoded = await decodeMinecraftJavaSave(files)

    expect(decoded.level).toStrictEqual(source.level)
    expect(decoded.levelBackup).toStrictEqual(source.levelBackup)
    expect(decoded.sessionLock).toBe(source.sessionLock)
    expect(decoded.icon).toStrictEqual(source.icon)
    expect(decoded.resourcePack).toStrictEqual(source.resourcePack)
    expect(decoded.playerData).toStrictEqual(source.playerData)
    expect(decoded.playerStats).toStrictEqual(source.playerStats)
    expect(decoded.playerAdvancements).toStrictEqual(source.playerAdvancements)
    expect(decoded.dataFiles).toHaveLength(source.dataFiles.length)
    for (const expected of source.dataFiles) {
      const actual = decoded.dataFiles.find(
        (candidate) =>
          candidate.dimension === expected.dimension &&
          candidate.namespace === expected.namespace &&
          candidate.name === expected.name,
      )
      expect(actual).toStrictEqual(expected)
    }
    expect(decoded.worldClocks).toStrictEqual(source.worldClocks)
    expect(decoded.structures).toStrictEqual(source.structures)
    expect(decoded.extraFiles).toStrictEqual(source.extraFiles)
    expect(decoded.regions).toHaveLength(source.regions.length)
    for (const expected of source.regions) {
      const actual = decoded.regions.find(
        (candidate) =>
          candidate.dimension === expected.dimension &&
          candidate.storage === expected.storage &&
          candidate.regionX === expected.regionX &&
          candidate.regionZ === expected.regionZ,
      )
      expect(actual).toStrictEqual(expected)
    }

    const encodedIcon = findFile(files, 'icon.png')
    encodedIcon.bytes[0] = 0
    expect(source.icon?.[0]).toBe(137)
  })

  it('rejects missing, malformed, duplicate, and unpaired files at the high-level boundary', async () => {
    const files = await encodeMinecraftJavaSave(fixture())
    const levelRemoved = files.filter((file) => file.path !== 'level.dat')
    const malformedJson = files.map((file) =>
      file.path === `players/stats/${PLAYER_ID}.json` ? { ...file, bytes: new Uint8Array([0xff]) } : file,
    )
    const malformedWorldClock = files.map((file) =>
      file.path === 'data/minecraft/world_clock/day.json'
        ? { ...file, bytes: new TextEncoder().encode('{"ticks":') }
        : file,
    )
    const externalOnly = files.filter((file) => !file.path.endsWith('/entities/r.-1.2.mca'))

    await expect(decodeMinecraftJavaSave(levelRemoved)).rejects.toBeInstanceOf(MinecraftJavaSaveError)
    await expect(decodeMinecraftJavaSave(malformedJson)).rejects.toThrow('players/stats')
    await expect(decodeMinecraftJavaSave(malformedWorldClock)).rejects.toThrow('world_clock/day.json')
    const firstFile = files[0]
    if (firstFile === undefined) throw new Error('fixture must encode at least one file')
    await expect(decodeMinecraftJavaSave([...files, firstFile])).rejects.toThrow('duplicate file path')
    await expect(decodeMinecraftJavaSave(externalOnly)).rejects.toThrow('no matching region file')
    await expect(decodeMinecraftJavaSave(files, { maxFiles: files.length - 1 })).rejects.toThrow('maxFiles')
    await expect(decodeMinecraftJavaSave(files, { maxTotalBytes: 0 })).rejects.toThrow('maxTotalBytes')
    await expect(encodeMinecraftJavaSave(fixture(), { maxFiles: 0 })).rejects.toThrow('maxFiles')
  })

  it('copies input file bytes and validates the public save model', async () => {
    const source = fixture()
    const files = await encodeMinecraftJavaSave(source)
    const decoded = await decodeMinecraftJavaSave(files)
    const level = findFile(files, 'level.dat')
    const originalLevelByte = level.bytes[0]
    level.bytes[0] = originalLevelByte === 0 ? 1 : 0
    expect(decoded.level).toStrictEqual(source.level)

    const encodedIcon = findFile(files, 'icon.png')
    encodedIcon.bytes[0] = 0
    expect(decoded.icon?.[0]).toBe(137)
    expect(source.icon?.[0]).toBe(137)

    await expect(
      // @ts-expect-error -- deliberately null level to verify runtime rejection
      encodeMinecraftJavaSave({ ...source, level: null }),
    ).rejects.toThrow(MinecraftJavaSaveError)
    await expect(
      encodeMinecraftJavaSave({ ...source, extraFiles: [{ path: '../escape', bytes: new Uint8Array() }] }),
    ).rejects.toThrow('unsafe path segment')
    await expect(
      decodeMinecraftJavaSave([{ path: 'level.dat', bytes: new Uint8Array([1, 2, 3]) }]),
    ).rejects.toThrow('gzip')
  })

  it('rejects non-canonical public model shapes before encoding', async () => {
    const source = fixture()
    const minimal: MinecraftJavaSave = {
      level: source.level,
      playerData: [],
      playerStats: [],
      playerAdvancements: [],
      regions: [],
      dataFiles: [],
      worldClocks: [],
      structures: [],
      extraFiles: [],
    }

    await expect(encodeMinecraftJavaSave(minimal)).resolves.toHaveLength(1)
    // @ts-expect-error -- deliberately non-object options to verify runtime rejection
    await expect(encodeMinecraftJavaSave(source, null)).rejects.toThrow('options must be an object')
    await expectInvalidSave(Object.create({}), 'save must be an object')

    const proxy = new Proxy({}, { getPrototypeOf: () => { throw new Error('hostile proxy') } })
    await expectInvalidSave(proxy, 'save must be an object')

    await expectInvalidSave({ ...source, playerData: new Array(1) }, 'playerData must be an array')
    const customArray = [...source.playerData]
    Object.setPrototypeOf(customArray, {})
    await expectInvalidSave({ ...source, playerData: customArray }, 'playerData must be an array')

    const nonEnumerableArray = [...source.playerData]
    Object.defineProperty(nonEnumerableArray, '0', { enumerable: false })
    await expectInvalidSave({ ...source, playerData: nonEnumerableArray }, 'playerData must be an array')

    const extraKeyArray = Object.assign([...source.playerData], { extra: true })
    await expectInvalidSave({ ...source, playerData: extraKeyArray }, 'playerData must be an array')
    await expectInvalidSave({ ...source, playerData: 1 }, 'playerData must be an array')
    await expectInvalidSave({ ...source, playerData: [{ playerId: '../escape', document: source.level }] }, 'playerId')

    const derivedBytes = new (class extends Uint8Array {})([1])
    await expectInvalidSave({ ...source, icon: derivedBytes }, 'icon must be a Uint8Array')
    const extraKeyBytes = Object.assign(new Uint8Array([1]), { extra: true })
    await expectInvalidSave({ ...source, icon: extraKeyBytes }, 'icon must be a Uint8Array')
    await expectInvalidSave({ ...source, sessionLock: 2n ** 63n }, 'sessionLock')

    await expectInvalidSave(
      { ...source, playerStats: [{ playerId: PLAYER_ID, value: undefined }] },
      'playerStats 0 is invalid',
    )
    await expectInvalidSave(
      { ...source, dataFiles: [{ namespace: 'example/ns', name: 'state.dat', document: source.level }] },
      'namespace or name is invalid',
    )
    await expectInvalidSave(
      { ...source, dataFiles: [{ namespace: 'example', name: 'state.dat', dimension: 'example:../moon', document: source.level }] },
      'dimension is invalid',
    )
    await expectInvalidSave(
      { ...source, worldClocks: [{ namespace: 'minecraft', id: '../day', value: {} }] },
      'worldClocks 0 is invalid',
    )
    await expectInvalidSave(
      { ...source, worldClocks: [{ namespace: 'minecraft', id: 'day', value: undefined }] },
      'worldClocks 0 is invalid',
    )
    await expectInvalidSave(
      { ...source, structures: [{ namespace: 'minecraft/ns', name: 'house', document: source.level }] },
      'namespace or name is invalid',
    )

    const firstRegion = source.regions[0]
    if (firstRegion === undefined) throw new Error('fixture must declare at least one region')

    await expectInvalidSave(
      {
        ...source,
        regions: [{ ...firstRegion, storage: 'invalid' }],
      },
      'regions 0 is invalid',
    )
    await expectInvalidSave(
      {
        ...source,
        regions: [{ ...firstRegion, regionX: Number.MAX_SAFE_INTEGER }],
      },
      'regions 0 is invalid',
    )

    const invalidChunkRegion = firstRegion.region
    const invalidChunks = [...invalidChunkRegion.chunks]
    const firstInvalidChunk = invalidChunks[0]
    if (firstInvalidChunk === undefined || firstInvalidChunk === null) {
      throw new Error('fixture region must declare a non-null first chunk')
    }
    invalidChunks[0] = { ...firstInvalidChunk, timestamp: -1 }
    await expectInvalidSave(
      {
        ...source,
        regions: [{ ...firstRegion, region: { ...invalidChunkRegion, chunks: invalidChunks } }],
      },
      'regions 0 is invalid',
    )

    const invalidRegion = { ...invalidChunkRegion, unexpected: true }
    await expectInvalidSave(
      { ...source, regions: [{ ...firstRegion, region: invalidRegion }] },
      'regions 0 is invalid',
    )

    const sparseTimestamps = new Array(ANVIL_CHUNK_COUNT)
    await expectInvalidSave(
      {
        ...source,
        regions: [{ ...firstRegion, region: { chunks: invalidChunkRegion.chunks, timestamps: sparseTimestamps } }],
      },
      'regions 0 is invalid',
    )
  })

  it('sorts multiple entries per category into canonical order', async () => {
    const secondPlayerId = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'
    const source: MinecraftJavaSave = {
      ...fixture(),
      playerData: [
        { playerId: PLAYER_ID, document: document('Player', 3) },
        { playerId: secondPlayerId, document: document('Player', 30) },
      ],
      playerStats: [
        { playerId: PLAYER_ID, value: { stats: { 'minecraft:jump': 4 } } },
        { playerId: secondPlayerId, value: { stats: { 'minecraft:jump': 40 } } },
      ],
      playerAdvancements: [
        { playerId: PLAYER_ID, value: { DataVersion: 4325, done: true } },
        { playerId: secondPlayerId, value: { DataVersion: 4325, done: false } },
      ],
      worldClocks: [
        { namespace: 'minecraft', id: 'day', value: { ticks: 12345, paused: false } },
        { namespace: 'minecraft', id: 'night', value: { ticks: 999, paused: true } },
      ],
      structures: [
        { namespace: 'minecraft', name: 'village/plains/houses/small_house_1', document: document('', 7) },
        { namespace: 'minecraft', name: 'village/plains/houses/small_house_2', document: document('', 8) },
      ],
    }
    const files = await encodeMinecraftJavaSave(source)
    const decoded = await decodeMinecraftJavaSave(files)

    expect(decoded.playerData.map((entry) => entry.playerId)).toStrictEqual([PLAYER_ID, secondPlayerId])
    expect(decoded.playerStats.map((entry) => entry.playerId)).toStrictEqual([PLAYER_ID, secondPlayerId])
    expect(decoded.playerAdvancements.map((entry) => entry.playerId)).toStrictEqual([PLAYER_ID, secondPlayerId])
    expect(decoded.worldClocks.map((entry) => entry.id)).toStrictEqual(['day', 'night'])
    expect(decoded.structures.map((entry) => entry.name)).toStrictEqual([
      'village/plains/houses/small_house_1',
      'village/plains/houses/small_house_2',
    ])
  })

  it('decodes a save that omits every optional top-level field', async () => {
    const minimal: MinecraftJavaSave = {
      level: document('Level', 1),
      playerData: [],
      playerStats: [],
      playerAdvancements: [],
      regions: [],
      dataFiles: [],
      worldClocks: [],
      structures: [],
      extraFiles: [],
    }
    const files = await encodeMinecraftJavaSave(minimal)
    expect(files).toHaveLength(1)
    const decoded = await decodeMinecraftJavaSave(files)

    expect(decoded.levelBackup).toBeUndefined()
    expect(decoded.sessionLock).toBeUndefined()
    expect(decoded.icon).toBeUndefined()
    expect(decoded.resourcePack).toBeUndefined()
  })

  it('reports a decode failure for a malformed session.lock payload', async () => {
    const files = await encodeMinecraftJavaSave(fixture())
    const corrupted = files.map((file) =>
      file.path === 'session.lock' ? { ...file, bytes: new Uint8Array([1, 2, 3]) } : file,
    )
    await expect(decodeMinecraftJavaSave(corrupted)).rejects.toThrow('session.lock')
  })

  it('reports a decode failure for a malformed region payload', async () => {
    const files = await encodeMinecraftJavaSave(fixture())
    const regionPath = 'dimensions/minecraft/overworld/region/r.0.0.mca'
    const corrupted = files.map((file) =>
      file.path === regionPath ? { ...file, bytes: new Uint8Array([1, 2, 3]) } : file,
    )
    await expect(decodeMinecraftJavaSave(corrupted)).rejects.toBeInstanceOf(MinecraftJavaSaveError)
    await expect(decodeMinecraftJavaSave(corrupted)).rejects.toThrow(regionPath)
  })

  it('reports a decode failure when a region path encodes a coordinate outside the safe integer range', async () => {
    const files = await encodeMinecraftJavaSave(fixture())
    const regionPath = 'dimensions/minecraft/overworld/region/r.0.0.mca'
    const withHugeCoordinate = [
      ...files.filter((file) => file.path !== regionPath),
      { path: 'dimensions/minecraft/overworld/region/r.99999999999999999999.0.mca', bytes: new Uint8Array([0]) },
    ]
    await expect(decodeMinecraftJavaSave(withHugeCoordinate)).rejects.toBeInstanceOf(MinecraftJavaSaveError)
    await expect(decodeMinecraftJavaSave(withHugeCoordinate)).rejects.toThrow('canonical safe integer')
  })

  it('decodes a region group carrying more than one external chunk', async () => {
    const chunks: Array<AnvilChunkRecord | null> = new Array(ANVIL_CHUNK_COUNT).fill(null)
    chunks[0] = {
      localX: 0,
      localZ: 0,
      timestamp: 1,
      compression: 'none',
      payload: new Uint8Array([1, 2, 3]),
      external: true,
    }
    chunks[1] = {
      localX: 1,
      localZ: 0,
      timestamp: 2,
      compression: 'none',
      payload: new Uint8Array([4, 5, 6]),
      external: true,
    }
    const source: MinecraftJavaSave = {
      ...fixture(),
      regions: [
        {
          dimension: 'overworld',
          storage: 'region',
          regionX: ChunkAxis(0),
          regionZ: ChunkAxis(0),
          region: anvilRegion(chunks),
        },
      ],
    }
    const files = await encodeMinecraftJavaSave(source)
    const decoded = await decodeMinecraftJavaSave(files)
    const region = decoded.regions.find((candidate) => candidate.dimension === 'overworld')
    expect(region).toBeDefined()
    expect(region?.region.chunks[0]?.payload).toStrictEqual(new Uint8Array([1, 2, 3]))
    expect(region?.region.chunks[1]?.payload).toStrictEqual(new Uint8Array([4, 5, 6]))
  })
})
