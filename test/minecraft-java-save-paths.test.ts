import { describe, expect, it } from 'vitest'
import { parseMinecraftJavaSavePath } from '../src/domain/minecraft-java-save-paths.js'

describe('Minecraft Java save path parsing', () => {
  it('recognizes the fixed top-level file names', () => {
    expect(parseMinecraftJavaSavePath('level.dat')).toStrictEqual({ kind: 'level', path: 'level.dat' })
    expect(parseMinecraftJavaSavePath('level.dat_old')).toStrictEqual({ kind: 'levelBackup', path: 'level.dat_old' })
    expect(parseMinecraftJavaSavePath('session.lock')).toStrictEqual({ kind: 'sessionLock', path: 'session.lock' })
    expect(parseMinecraftJavaSavePath('icon.png')).toStrictEqual({ kind: 'icon', path: 'icon.png' })
    expect(parseMinecraftJavaSavePath('resourcepacks/resources.zip')).toStrictEqual({
      kind: 'resourcePack',
      path: 'resourcepacks/resources.zip',
    })
  })

  it('parses player data and json paths and rejects malformed shapes', () => {
    const playerId = '01234567-89ab-cdef-0123-456789abcdef'
    expect(parseMinecraftJavaSavePath(`players/data/${playerId}.dat`)).toStrictEqual({
      kind: 'playerData',
      playerId,
      path: `players/data/${playerId}.dat`,
    })
    expect(parseMinecraftJavaSavePath(`players/stats/${playerId}.json`)).toStrictEqual({
      kind: 'playerJson',
      category: 'stats',
      playerId,
      path: `players/stats/${playerId}.json`,
    })
    expect(parseMinecraftJavaSavePath(`players/advancements/${playerId}.json`)).toStrictEqual({
      kind: 'playerJson',
      category: 'advancements',
      playerId,
      path: `players/advancements/${playerId}.json`,
    })

    // wrong segment count
    expect(parseMinecraftJavaSavePath(`players/${playerId}.dat`).kind).toBe('extra')
    // wrong top-level directory
    expect(parseMinecraftJavaSavePath(`other/data/${playerId}.dat`).kind).toBe('extra')
    // unknown category
    expect(parseMinecraftJavaSavePath(`players/unknown/${playerId}.dat`).kind).toBe('extra')
    // file segment collapses to an unsafe playerId once the extension is stripped
    expect(parseMinecraftJavaSavePath(`players/data/..dat`).kind).toBe('extra')
    expect(parseMinecraftJavaSavePath('players/data/.dat').kind).toBe('extra')
    // wrong extension for category
    expect(parseMinecraftJavaSavePath(`players/data/${playerId}.json`).kind).toBe('extra')
    expect(parseMinecraftJavaSavePath(`players/stats/${playerId}.dat`).kind).toBe('extra')
    // file segment itself carries a character outside SAFE_SEGMENT (a space)
    expect(parseMinecraftJavaSavePath('players/data/bad name.dat').kind).toBe('extra')
  })

  it('parses region and external chunk paths across every storage kind and rejects malformed ones', () => {
    expect(parseMinecraftJavaSavePath('dimensions/minecraft/overworld/region/r.0.0.mca')).toStrictEqual({
      kind: 'region',
      dimension: 'overworld',
      storage: 'region',
      regionX: 0,
      regionZ: 0,
      path: 'dimensions/minecraft/overworld/region/r.0.0.mca',
    })
    expect(parseMinecraftJavaSavePath('dimensions/minecraft/the_nether/region/r.-1.2.mca')).toStrictEqual({
      kind: 'region',
      dimension: 'the_nether',
      storage: 'region',
      regionX: -1,
      regionZ: 2,
      path: 'dimensions/minecraft/the_nether/region/r.-1.2.mca',
    })
    expect(parseMinecraftJavaSavePath('dimensions/minecraft/the_end/poi/r.1.-2.mca')).toMatchObject({
      dimension: 'the_end',
      storage: 'poi',
    })
    expect(parseMinecraftJavaSavePath('dimensions/example/moon/entities/r.-1.2.mca')).toMatchObject({
      dimension: 'example:moon',
      storage: 'entities',
    })
    expect(parseMinecraftJavaSavePath('dimensions/example/moon/entities/c.0.0.mcc')).toStrictEqual({
      kind: 'externalChunk',
      dimension: 'example:moon',
      storage: 'entities',
      chunkX: 0,
      chunkZ: 0,
      path: 'dimensions/example/moon/entities/c.0.0.mcc',
    })

    // too few segments to be a region path at all
    expect(parseMinecraftJavaSavePath('region/r.0.0.mca').kind).toBe('extra')
    // enough segments, but the directory prefix does not start with 'dimensions'
    expect(parseMinecraftJavaSavePath('notdimensions/example/moon/region/r.0.0.mca').kind).toBe('extra')
    // dimension directory namespace itself is unsafe
    expect(parseMinecraftJavaSavePath('dimensions/../moon/region/r.0.0.mca').kind).toBe('extra')
    // unknown storage directory
    expect(parseMinecraftJavaSavePath('dimensions/minecraft/overworld/unknownstorage/r.0.0.mca').kind).toBe('extra')
    // file matches neither region nor external chunk pattern
    expect(parseMinecraftJavaSavePath('dimensions/minecraft/overworld/region/r.0.0.mcx').kind).toBe('extra')
    // dimension directory invalid (unsafe segment)
    expect(parseMinecraftJavaSavePath('dimensions/example/../region/r.0.0.mca').kind).toBe('extra')
    // dimensions path missing a namespace/path segment before storage+file
    expect(parseMinecraftJavaSavePath('dimensions/example/region/r.0.0.mca').kind).toBe('extra')
  })

  it('rejects region and external chunk coordinates outside the safe integer range', () => {
    expect(() =>
      parseMinecraftJavaSavePath('dimensions/minecraft/overworld/region/r.99999999999999999999.0.mca'),
    ).toThrow(TypeError)
    expect(() =>
      parseMinecraftJavaSavePath('dimensions/minecraft/overworld/region/c.99999999999999999999.0.mcc'),
    ).toThrow(TypeError)
  })

  it('parses data, world clock, and structure paths under every valid directory shape', () => {
    expect(parseMinecraftJavaSavePath('data/minecraft/raids.dat')).toStrictEqual({
      kind: 'data',
      namespace: 'minecraft',
      name: 'raids.dat',
      path: 'data/minecraft/raids.dat',
    })
    expect(parseMinecraftJavaSavePath('dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat')).toStrictEqual({
      kind: 'data',
      dimension: 'the_end',
      namespace: 'minecraft',
      name: 'ender_dragon_fight.dat',
      path: 'dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat',
    })
    expect(parseMinecraftJavaSavePath('data/minecraft/world_clock/day.json')).toStrictEqual({
      kind: 'worldClock',
      namespace: 'minecraft',
      id: 'day',
      path: 'data/minecraft/world_clock/day.json',
    })
    expect(parseMinecraftJavaSavePath('data/minecraft/world_clock/nested/day.json')).toStrictEqual({
      kind: 'worldClock',
      namespace: 'minecraft',
      id: 'nested/day',
      path: 'data/minecraft/world_clock/nested/day.json',
    })
    expect(parseMinecraftJavaSavePath('generated/minecraft/structure/village/plains/houses/small_house_1.nbt')).toStrictEqual(
      {
        kind: 'structure',
        namespace: 'minecraft',
        name: 'village/plains/houses/small_house_1',
        path: 'generated/minecraft/structure/village/plains/houses/small_house_1.nbt',
      },
    )

    // dimensions prefix present but no 'data' segment found within the scan window
    expect(parseMinecraftJavaSavePath('dimensions/minecraft/the_end/nope/minecraft/x.dat').kind).toBe('extra')
    // a 'data' segment is found, but its directory prefix fails dimensionFromDirectory, so the scan
    // must continue past it (here, to exhaustion, since there is no other 'data' segment to fall back to)
    expect(parseMinecraftJavaSavePath('dimensions/../nested/data/ns/name.dat').kind).toBe('extra')
    // too short after the data segment
    expect(parseMinecraftJavaSavePath('data/minecraft').kind).toBe('extra')
    // unsafe namespace
    expect(parseMinecraftJavaSavePath('data/../raids.dat').kind).toBe('extra')
    // unsafe nested name segment
    expect(parseMinecraftJavaSavePath('data/minecraft/../raids.dat').kind).toBe('extra')

    // world clock's own extension/id checks fail but the generic 'data' parser still accepts the path,
    // since anything under data/<namespace>/... that isn't a recognized shape falls back to a plain data file
    expect(parseMinecraftJavaSavePath('data/minecraft/world_clock/day.txt')).toStrictEqual({
      kind: 'data',
      namespace: 'minecraft',
      name: 'world_clock/day.txt',
      path: 'data/minecraft/world_clock/day.txt',
    })
    expect(parseMinecraftJavaSavePath('data/minecraft/world_clock/..json')).toStrictEqual({
      kind: 'data',
      namespace: 'minecraft',
      name: 'world_clock/..json',
      path: 'data/minecraft/world_clock/..json',
    })
    // world clock: wrong top-level directory or missing marker segment
    expect(parseMinecraftJavaSavePath('other/minecraft/world_clock/day.json').kind).toBe('extra')
    // world clock: unsafe namespace (also rejected by the data fallback)
    expect(parseMinecraftJavaSavePath('data/../world_clock/day.json').kind).toBe('extra')
    // world clock: unsafe intermediate id segment (also rejected by the data fallback)
    expect(parseMinecraftJavaSavePath('data/minecraft/world_clock/../day.json').kind).toBe('extra')

    // structure: too few segments / wrong marker directory (no data-path fallback applies here)
    expect(parseMinecraftJavaSavePath('generated/minecraft/house.nbt').kind).toBe('extra')
    expect(parseMinecraftJavaSavePath('other/minecraft/structure/house.nbt').kind).toBe('extra')
    // structure: unsafe namespace
    expect(parseMinecraftJavaSavePath('generated/../structure/house.nbt').kind).toBe('extra')
    // structure: wrong extension
    expect(parseMinecraftJavaSavePath('generated/minecraft/structure/house.txt').kind).toBe('extra')
    // structure: unsafe name or intermediate segment
    expect(parseMinecraftJavaSavePath('generated/minecraft/structure/..nbt').kind).toBe('extra')
    expect(parseMinecraftJavaSavePath('generated/minecraft/structure/../house.nbt').kind).toBe('extra')
  })

  it('falls back to extra for anything unrecognized', () => {
    expect(parseMinecraftJavaSavePath('datapacks/example/pack.mcmeta')).toStrictEqual({
      kind: 'extra',
      path: 'datapacks/example/pack.mcmeta',
    })
    expect(parseMinecraftJavaSavePath('unknown.bin')).toStrictEqual({ kind: 'extra', path: 'unknown.bin' })
  })
})
