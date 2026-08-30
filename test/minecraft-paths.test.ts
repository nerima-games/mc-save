import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE_XZ, chunkCoord } from '@nerima-games/mc-kernel'
import {
  ANVIL_REGION_BLOCK_SIDE,
  anvilChunkIndex,
  anvilChunkLocalCoordinate,
  anvilRegionCoordinate,
  anvilRegionFileName,
  minecraftAdvancementsPath,
  minecraftChunkTicketsPath,
  minecraftCommandStoragePath,
  minecraftDataFilePath,
  minecraftEnderDragonFightPath,
  minecraftCustomBossEventsPath,
  minecraftGameRulesPath,
  minecraftDimensionDirectory,
  minecraftExternalChunkFileName,
  minecraftExternalChunkFilePath,
  minecraftIconPath,
  minecraftLevelDataBackupPath,
  minecraftLevelDataPath,
  minecraftLastIdPath,
  minecraftMapFilePath,
  minecraftPlayerDataPath,
  minecraftRegionFilePath,
  minecraftRaidsPath,
  minecraftScoreboardPath,
  minecraftScheduledEventsPath,
  minecraftSessionLockPath,
  minecraftStatsPath,
  minecraftStructurePath,
  minecraftWorldResourcePackPath,
  minecraftWanderingTraderPath,
  minecraftWeatherPath,
  minecraftWorldBorderPath,
  minecraftWorldClocksPath,
  minecraftWorldClockPath,
  minecraftWorldGenSettingsPath,
} from '../src/index.js'

describe('Minecraft Anvil path calculations', () => {
  it('maps the three official dimension names to save directories', () => {
    expect(minecraftDimensionDirectory('overworld')).toBe('dimensions/minecraft/overworld')
    expect(minecraftDimensionDirectory('the_nether')).toBe('dimensions/minecraft/the_nether')
    expect(minecraftDimensionDirectory('the_end')).toBe('dimensions/minecraft/the_end')
    expect(minecraftDimensionDirectory('minecraft:overworld')).toBe('dimensions/minecraft/overworld')
    expect(minecraftDimensionDirectory('minecraft:the_nether')).toBe('dimensions/minecraft/the_nether')
    expect(minecraftDimensionDirectory('minecraft:the_end')).toBe('dimensions/minecraft/the_end')
    expect(minecraftDimensionDirectory('example:moon')).toBe('dimensions/example/moon')
    expect(minecraftDimensionDirectory('example:deep/moon')).toBe('dimensions/example/deep/moon')
  })

  it('rejects unsupported runtime dimension names', () => {
    expect(() => minecraftDimensionDirectory('custom' as never)).toThrow('unsupported Minecraft dimension custom')
    expect(() => minecraftDimensionDirectory('Example:moon' as never)).toThrow(
      'unsupported Minecraft dimension Example:moon',
    )
    expect(() => minecraftDimensionDirectory('example:' as never)).toThrow('unsupported Minecraft dimension example:')
    expect(() => minecraftDimensionDirectory('example:bad//path' as never)).toThrow(
      'unsupported Minecraft dimension example:bad//path',
    )
    expect(() => minecraftDimensionDirectory('example:../path' as never)).toThrow(
      'unsupported Minecraft dimension example:../path',
    )
    expect(() => minecraftDimensionDirectory('..:path' as never)).toThrow(
      'unsupported Minecraft dimension ..:path',
    )
    expect(() => minecraftDimensionDirectory('example:one:two' as never)).toThrow(
      'unsupported Minecraft dimension example:one:two',
    )
  })

  it('uses floor division for negative region coordinates', () => {
    expect(anvilRegionCoordinate(chunkCoord(0, 0))).toEqual({ rx: 0, rz: 0 })
    expect(anvilRegionCoordinate(chunkCoord(31, -1))).toEqual({ rx: 0, rz: -1 })
    expect(anvilRegionCoordinate(chunkCoord(-1, -32))).toEqual({ rx: -1, rz: -1 })
    expect(anvilRegionCoordinate(chunkCoord(32, 64))).toEqual({ rx: 1, rz: 2 })
  })

  it('rejects forged chunk coordinates at the runtime path boundary', () => {
    expect(() => anvilChunkIndex(null as never)).toThrow('chunk coordinate must be an object')
    expect(() => anvilRegionCoordinate('invalid' as never)).toThrow('chunk coordinate must be an object')
    expect(() => anvilChunkIndex({ cx: Number.NaN, cz: 0 } as never)).toThrow(
      'chunk coordinate axes must be safe integers',
    )
    expect(() => minecraftExternalChunkFileName({ cx: '../escape', cz: 0 } as never)).toThrow(
      'chunk coordinate axes must be safe integers',
    )
  })

  it('normalizes local coordinates and computes the 1024-slot index', () => {
    expect(anvilChunkLocalCoordinate(chunkCoord(-1, -33))).toEqual({ x: 31, z: 31 })
    expect(anvilChunkLocalCoordinate(chunkCoord(32, 32))).toEqual({ x: 0, z: 0 })
    expect(anvilChunkIndex(chunkCoord(-1, -1))).toBe(1023)
    expect(anvilChunkIndex(chunkCoord(32, 32))).toBe(0)
  })

  it('builds official region file names and dimension-relative paths', () => {
    const coord = chunkCoord(-1, 64)

    expect(anvilRegionFileName(coord)).toBe('r.-1.2.mca')
    expect(minecraftRegionFilePath('overworld', coord)).toBe('dimensions/minecraft/overworld/region/r.-1.2.mca')
    expect(minecraftRegionFilePath('the_nether', coord)).toBe('dimensions/minecraft/the_nether/region/r.-1.2.mca')
    expect(minecraftRegionFilePath('the_end', coord)).toBe('dimensions/minecraft/the_end/region/r.-1.2.mca')
    expect(minecraftRegionFilePath('example:moon', coord, 'entities')).toBe('dimensions/example/moon/entities/r.-1.2.mca')
    expect(minecraftRegionFilePath('overworld', coord, 'poi')).toBe(
      'dimensions/minecraft/overworld/poi/r.-1.2.mca',
    )
    expect(() => minecraftRegionFilePath('overworld', coord, 'invalid' as never)).toThrow(
      'unsupported Minecraft region storage invalid',
    )
    expect(minecraftExternalChunkFileName(coord)).toBe('c.-1.64.mcc')
    expect(minecraftExternalChunkFilePath('overworld', coord)).toBe(
      'dimensions/minecraft/overworld/region/c.-1.64.mcc',
    )
    expect(minecraftExternalChunkFilePath('the_nether', coord, 'entities')).toBe(
      'dimensions/minecraft/the_nether/entities/c.-1.64.mcc',
    )
    expect(minecraftExternalChunkFilePath('example:moon', coord, 'poi')).toBe(
      'dimensions/example/moon/poi/c.-1.64.mcc',
    )
    expect(ANVIL_REGION_BLOCK_SIDE).toBe(CHUNK_SIZE_XZ * 32)
  })

  it('builds the standard world-level save paths', () => {
    expect(minecraftLevelDataPath()).toBe('level.dat')
    expect(minecraftLevelDataBackupPath()).toBe('level.dat_old')
    expect(minecraftIconPath()).toBe('icon.png')
    expect(minecraftSessionLockPath()).toBe('session.lock')
    expect(minecraftPlayerDataPath('01234567-89ab-cdef-0123-456789abcdef')).toBe(
      'players/data/01234567-89ab-cdef-0123-456789abcdef.dat',
    )
    expect(minecraftStatsPath('01234567-89ab-cdef-0123-456789abcdef')).toBe(
      'players/stats/01234567-89ab-cdef-0123-456789abcdef.json',
    )
    expect(minecraftAdvancementsPath('01234567-89ab-cdef-0123-456789abcdef')).toBe(
      'players/advancements/01234567-89ab-cdef-0123-456789abcdef.json',
    )
    expect(minecraftDataFilePath('minecraft', 'raids.dat')).toBe('data/minecraft/raids.dat')
    expect(minecraftDataFilePath('minecraft', 'ender_dragon_fight.dat', 'the_end')).toBe(
      'dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat',
    )
    expect(minecraftRaidsPath()).toBe('data/minecraft/raids.dat')
    expect(minecraftScoreboardPath()).toBe('data/minecraft/scoreboard.dat')
    expect(minecraftWorldBorderPath()).toBe('data/minecraft/world_border.dat')
    expect(minecraftEnderDragonFightPath()).toBe(
      'dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat',
    )
    expect(minecraftWanderingTraderPath()).toBe('data/minecraft/wandering_trader.dat')
    expect(minecraftCustomBossEventsPath()).toBe('data/minecraft/custom_boss_events.dat')
    expect(minecraftWeatherPath()).toBe('data/minecraft/weather.dat')
    expect(minecraftScheduledEventsPath()).toBe('data/minecraft/scheduled_events.dat')
    expect(minecraftGameRulesPath()).toBe('data/minecraft/game_rules.dat')
    expect(minecraftWorldGenSettingsPath()).toBe('data/minecraft/world_gen_settings.dat')
    expect(minecraftWorldClocksPath()).toBe('data/minecraft/world_clocks.dat')
    expect(minecraftWorldClockPath('minecraft', 'day')).toBe('data/minecraft/world_clock/day.json')
    expect(minecraftCommandStoragePath('foo')).toBe('data/foo/command_storage.dat')
    expect(minecraftCommandStoragePath('foo', 'the_nether')).toBe(
      'dimensions/minecraft/the_nether/data/foo/command_storage.dat',
    )
    expect(minecraftMapFilePath(7)).toBe('data/minecraft/maps/7.dat')
    expect(minecraftMapFilePath('8')).toBe('data/minecraft/maps/8.dat')
    expect(minecraftLastIdPath()).toBe('data/minecraft/last_id.dat')
    expect(minecraftChunkTicketsPath()).toBe('data/minecraft/chunk_tickets.dat')
    expect(minecraftWorldResourcePackPath()).toBe('resourcepacks/resources.zip')
    expect(minecraftStructurePath('minecraft', 'village/plains/houses/small_house_1')).toBe(
      'generated/minecraft/structure/village/plains/houses/small_house_1.nbt',
    )
    expect(() => minecraftPlayerDataPath('../player')).toThrow('player id must be a single safe path segment')
    expect(() => minecraftStatsPath('.')).toThrow('player id must be a single safe path segment')
    expect(() => minecraftAdvancementsPath('player/name')).toThrow('player id must be a single safe path segment')
    expect(() => minecraftDataFilePath('..', 'raids.dat')).toThrow(
      'data namespace must be a single safe path segment',
    )
    expect(() => minecraftDataFilePath('minecraft', '..')).toThrow(
      'data file name must be a single safe path segment',
    )
    expect(() => minecraftMapFilePath(-1)).toThrow('map id must be a non-negative safe integer')
    expect(() => minecraftMapFilePath(1.5)).toThrow('map id must be a non-negative safe integer')
    expect(() => minecraftMapFilePath('-1')).toThrow('map id must be a non-negative safe integer')
    expect(() => minecraftMapFilePath('map/name')).toThrow('map id must be a non-negative safe integer')
    expect(() => minecraftStructurePath('minecraft', '../escape')).toThrow(
      'structure name must be a single safe path segment',
    )
    expect(() => minecraftStructurePath('minecraft', 'village//house')).toThrow(
      'structure name must be a safe relative path',
    )
    expect(() => minecraftWorldClockPath('../minecraft', 'day')).toThrow(
      'world clock namespace must be a single safe path segment',
    )
    expect(() => minecraftWorldClockPath('minecraft', '../day')).toThrow(
      'world clock id must be a single safe path segment',
    )
  })
})
