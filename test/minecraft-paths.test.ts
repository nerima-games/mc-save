import { ChunkAxis, CHUNK_SIZE_XZ, chunkCoord } from '@nerima-games/mc-kernel/domain/coordinates'
import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'

const unwrapResult = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const parsePathSegment = (value: unknown) => unwrapResult(api.parseMinecraftPathSegment(value))
const parseRelativePath = (value: unknown) => unwrapResult(api.parseMinecraftRelativePath(value))
const parseDimension = (value: unknown) => unwrapResult(api.parseMinecraftDimension(value))
const parseMapId = (value: unknown) => unwrapResult(api.parseMinecraftMapId(value))
const {
  ANVIL_REGION_BLOCK_SIDE,
  minecraftChunkTicketsPath,
  minecraftIconPath,
  minecraftLevelDataBackupPath,
  minecraftLevelDataPath,
  minecraftLastIdPath,
  minecraftSessionLockPath,
  minecraftWorldResourcePackPath,
} = api
const anvilChunkIndex = (...args: Parameters<typeof api.anvilChunkIndex>) => unwrapResult(api.anvilChunkIndex(...args))
const anvilChunkLocalCoordinate = (...args: Parameters<typeof api.anvilChunkLocalCoordinate>) => unwrapResult(api.anvilChunkLocalCoordinate(...args))
const anvilRegionCoordinate = (...args: Parameters<typeof api.anvilRegionCoordinate>) => unwrapResult(api.anvilRegionCoordinate(...args))
const anvilRegionFileName = (...args: Parameters<typeof api.anvilRegionFileName>) => unwrapResult(api.anvilRegionFileName(...args))
const minecraftAdvancementsPath = (...args: Parameters<typeof api.minecraftAdvancementsPath>) => unwrapResult(api.minecraftAdvancementsPath(...args))
const minecraftCommandStoragePath = (...args: Parameters<typeof api.minecraftCommandStoragePath>) => unwrapResult(api.minecraftCommandStoragePath(...args))
const minecraftDataFilePath = (...args: Parameters<typeof api.minecraftDataFilePath>) => unwrapResult(api.minecraftDataFilePath(...args))
const minecraftEnderDragonFightPath = (...args: Parameters<typeof api.minecraftEnderDragonFightPath>) => unwrapResult(api.minecraftEnderDragonFightPath(...args))
const minecraftCustomBossEventsPath = (...args: Parameters<typeof api.minecraftCustomBossEventsPath>) => unwrapResult(api.minecraftCustomBossEventsPath(...args))
const minecraftGameRulesPath = (...args: Parameters<typeof api.minecraftGameRulesPath>) => unwrapResult(api.minecraftGameRulesPath(...args))
const minecraftDimensionDirectory = (...args: Parameters<typeof api.minecraftDimensionDirectory>) => unwrapResult(api.minecraftDimensionDirectory(...args))
const minecraftExternalChunkFileName = (...args: Parameters<typeof api.minecraftExternalChunkFileName>) => unwrapResult(api.minecraftExternalChunkFileName(...args))
const minecraftExternalChunkFilePath = (...args: Parameters<typeof api.minecraftExternalChunkFilePath>) => unwrapResult(api.minecraftExternalChunkFilePath(...args))
const minecraftMapFilePath = (...args: Parameters<typeof api.minecraftMapFilePath>) => unwrapResult(api.minecraftMapFilePath(...args))
const minecraftPlayerDataPath = (...args: Parameters<typeof api.minecraftPlayerDataPath>) => unwrapResult(api.minecraftPlayerDataPath(...args))
const minecraftRegionFilePath = (...args: Parameters<typeof api.minecraftRegionFilePath>) => unwrapResult(api.minecraftRegionFilePath(...args))
const minecraftRaidsPath = (...args: Parameters<typeof api.minecraftRaidsPath>) => unwrapResult(api.minecraftRaidsPath(...args))
const minecraftScoreboardPath = (...args: Parameters<typeof api.minecraftScoreboardPath>) => unwrapResult(api.minecraftScoreboardPath(...args))
const minecraftScheduledEventsPath = (...args: Parameters<typeof api.minecraftScheduledEventsPath>) => unwrapResult(api.minecraftScheduledEventsPath(...args))
const minecraftStatsPath = (...args: Parameters<typeof api.minecraftStatsPath>) => unwrapResult(api.minecraftStatsPath(...args))
const minecraftStructurePath = (...args: Parameters<typeof api.minecraftStructurePath>) => unwrapResult(api.minecraftStructurePath(...args))
const minecraftWanderingTraderPath = (...args: Parameters<typeof api.minecraftWanderingTraderPath>) => unwrapResult(api.minecraftWanderingTraderPath(...args))
const minecraftWeatherPath = (...args: Parameters<typeof api.minecraftWeatherPath>) => unwrapResult(api.minecraftWeatherPath(...args))
const minecraftWorldBorderPath = (...args: Parameters<typeof api.minecraftWorldBorderPath>) => unwrapResult(api.minecraftWorldBorderPath(...args))
const minecraftWorldClocksPath = (...args: Parameters<typeof api.minecraftWorldClocksPath>) => unwrapResult(api.minecraftWorldClocksPath(...args))
const minecraftWorldClockPath = (...args: Parameters<typeof api.minecraftWorldClockPath>) => unwrapResult(api.minecraftWorldClockPath(...args))
const minecraftWorldGenSettingsPath = (...args: Parameters<typeof api.minecraftWorldGenSettingsPath>) => unwrapResult(api.minecraftWorldGenSettingsPath(...args))

describe('Minecraft Anvil path calculations', () => {
  it('returns Result failures for invalid branded inputs', () => {
    expect(Result.isFailure(api.parseMinecraftPathSegment('../escape'))).toBe(true)
    expect(Result.isFailure(api.parseMinecraftPathSegment(null))).toBe(true)
    expect(Result.isFailure(api.parseMinecraftRelativePath('village//house'))).toBe(true)
    expect(Result.isFailure(api.parseMinecraftRelativePath(null))).toBe(true)
    expect(Result.isFailure(api.parseMinecraftDimension('example:../path'))).toBe(true)
    expect(Result.isFailure(api.parseMinecraftDimension('example:one:two'))).toBe(true)
    expect(Result.isFailure(api.parseMinecraftDimension(null))).toBe(true)
    expect(Result.isFailure(api.parseMinecraftMapId(-1))).toBe(true)
    expect(Result.isFailure(api.parseMinecraftMapId(null))).toBe(true)
    expect(Result.isFailure(api.minecraftDimensionDirectory(null))).toBe(true)
  })

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
    expect(Result.isFailure(api.minecraftDimensionDirectory('example:../path'))).toBe(true)
    // minecraftDimensionDirectory accepts unknown input at this runtime boundary
    // and returns a failed Result for unsupported or unsafe identifiers.
    expect(() => {
      minecraftDimensionDirectory('custom')
    }).toThrow('unsupported Minecraft dimension custom')
    expect(() => minecraftDimensionDirectory('Example:moon')).toThrow(
      'unsupported Minecraft dimension Example:moon',
    )
    expect(() => minecraftDimensionDirectory('example:')).toThrow('unsupported Minecraft dimension example:')
    expect(() => minecraftDimensionDirectory('example:bad//path')).toThrow(
      'unsupported Minecraft dimension example:bad//path',
    )
    expect(() => minecraftDimensionDirectory('example:../path')).toThrow(
      'unsupported Minecraft dimension example:../path',
    )
    expect(() => minecraftDimensionDirectory('..:path')).toThrow('unsupported Minecraft dimension ..:path')
    expect(() => minecraftDimensionDirectory('example:one:two')).toThrow(
      'unsupported Minecraft dimension example:one:two',
    )
  })

  it('uses floor division for negative region coordinates', () => {
    expect(anvilRegionCoordinate(chunkCoord(ChunkAxis(0), ChunkAxis(0)))).toEqual({ rx: 0, rz: 0 })
    expect(anvilRegionCoordinate(chunkCoord(ChunkAxis(31), ChunkAxis(-1)))).toEqual({ rx: 0, rz: -1 })
    expect(anvilRegionCoordinate(chunkCoord(ChunkAxis(-1), ChunkAxis(-32)))).toEqual({ rx: -1, rz: -1 })
    expect(anvilRegionCoordinate(chunkCoord(ChunkAxis(32), ChunkAxis(64)))).toEqual({ rx: 1, rz: 2 })
  })

  it('rejects forged chunk coordinates at the runtime path boundary', () => {
    expect(
      Result.isFailure(
        // @ts-expect-error -- deliberately not a ChunkCoord, exercising the Result boundary
        api.anvilChunkIndex(null),
      ),
    ).toBe(true)
    // Each call below passes a value that is not a ChunkCoord, to exercise
    // the runtime guard a caller that skipped the type system would hit.
    expect(() => {
      // @ts-expect-error -- not a ChunkCoord, exercising the runtime guard
      anvilChunkIndex(null)
    }).toThrow('chunk coordinate must be an object')
    expect(() => {
      // @ts-expect-error -- not a ChunkCoord, exercising the runtime guard
      anvilRegionCoordinate('invalid')
    }).toThrow('chunk coordinate must be an object')
    expect(() => {
      // @ts-expect-error -- not a ChunkCoord, exercising the runtime guard
      anvilChunkIndex({ cx: Number.NaN, cz: 0 })
    }).toThrow('chunk coordinate axes must be safe integers')
    expect(() => {
      // @ts-expect-error -- not a ChunkCoord, exercising the runtime guard
      minecraftExternalChunkFileName({ cx: '../escape', cz: 0 })
    }).toThrow('chunk coordinate axes must be safe integers')

    const throwingX = Object.defineProperty({ cz: 0 }, 'cx', {
      get: () => {
        throw new Error('unreadable x coordinate')
      },
    })
    // @ts-expect-error -- deliberately hostile coordinate getter
    const throwingXResult = api.anvilChunkIndex(throwingX)
    expect(Result.isFailure(throwingXResult)).toBe(true)
    if (Result.isFailure(throwingXResult)) {
      expect(throwingXResult.failure.message).toBe('chunk coordinate must be an object')
    }

    // @ts-expect-error -- deliberately unsafe Z coordinate to reach its validation result
    const unsafeZResult = api.anvilRegionCoordinate({ cx: 0, cz: Number.NaN })
    expect(Result.isFailure(unsafeZResult)).toBe(true)
    if (Result.isFailure(unsafeZResult)) {
      expect(unsafeZResult.failure.message).toBe('chunk coordinate axes must be safe integers')
    }
  })

  it('normalizes local coordinates and computes the 1024-slot index', () => {
    expect(anvilChunkLocalCoordinate(chunkCoord(ChunkAxis(-1), ChunkAxis(-33)))).toEqual({ x: 31, z: 31 })
    expect(anvilChunkLocalCoordinate(chunkCoord(ChunkAxis(32), ChunkAxis(32)))).toEqual({ x: 0, z: 0 })
    expect(anvilChunkIndex(chunkCoord(ChunkAxis(-1), ChunkAxis(-1)))).toBe(1023)
    expect(anvilChunkIndex(chunkCoord(ChunkAxis(32), ChunkAxis(32)))).toBe(0)
  })

  it('builds official region file names and dimension-relative paths', () => {
    const coord = chunkCoord(ChunkAxis(-1), ChunkAxis(64))

    expect(anvilRegionFileName(coord)).toBe('r.-1.2.mca')
    expect(minecraftRegionFilePath('overworld', coord)).toBe('dimensions/minecraft/overworld/region/r.-1.2.mca')
    expect(minecraftRegionFilePath('the_nether', coord)).toBe('dimensions/minecraft/the_nether/region/r.-1.2.mca')
    expect(minecraftRegionFilePath('the_end', coord)).toBe('dimensions/minecraft/the_end/region/r.-1.2.mca')
    expect(minecraftRegionFilePath(parseDimension('example:moon'), coord, 'entities')).toBe('dimensions/example/moon/entities/r.-1.2.mca')
    expect(minecraftRegionFilePath('overworld', coord, 'poi')).toBe(
      'dimensions/minecraft/overworld/poi/r.-1.2.mca',
    )
    expect(() => {
      // @ts-expect-error -- not a supported region storage kind, exercising the runtime guard
      minecraftRegionFilePath('overworld', coord, 'invalid')
    }).toThrow('unsupported Minecraft region storage invalid')
    expect(minecraftExternalChunkFileName(coord)).toBe('c.-1.64.mcc')
    expect(minecraftExternalChunkFilePath('overworld', coord)).toBe(
      'dimensions/minecraft/overworld/region/c.-1.64.mcc',
    )
    expect(minecraftExternalChunkFilePath('the_nether', coord, 'entities')).toBe(
      'dimensions/minecraft/the_nether/entities/c.-1.64.mcc',
    )
    expect(minecraftExternalChunkFilePath(parseDimension('example:moon'), coord, 'poi')).toBe(
      'dimensions/example/moon/poi/c.-1.64.mcc',
    )
    expect(ANVIL_REGION_BLOCK_SIDE).toBe(CHUNK_SIZE_XZ * 32)
  })

  it('builds the standard world-level save paths', () => {
    expect(minecraftLevelDataPath()).toBe('level.dat')
    expect(minecraftLevelDataBackupPath()).toBe('level.dat_old')
    expect(minecraftIconPath()).toBe('icon.png')
    expect(minecraftSessionLockPath()).toBe('session.lock')
    expect(minecraftPlayerDataPath(parsePathSegment('01234567-89ab-cdef-0123-456789abcdef'))).toBe(
      'players/data/01234567-89ab-cdef-0123-456789abcdef.dat',
    )
    expect(minecraftStatsPath(parsePathSegment('01234567-89ab-cdef-0123-456789abcdef'))).toBe(
      'players/stats/01234567-89ab-cdef-0123-456789abcdef.json',
    )
    expect(minecraftAdvancementsPath(parsePathSegment('01234567-89ab-cdef-0123-456789abcdef'))).toBe(
      'players/advancements/01234567-89ab-cdef-0123-456789abcdef.json',
    )
    expect(minecraftDataFilePath(parsePathSegment('minecraft'), parseRelativePath('raids.dat'))).toBe('data/minecraft/raids.dat')
    expect(minecraftDataFilePath(parsePathSegment('minecraft'), parseRelativePath('ender_dragon_fight.dat'), 'the_end')).toBe(
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
    expect(minecraftWorldClockPath(parsePathSegment('minecraft'), parseRelativePath('day'))).toBe('data/minecraft/world_clock/day.json')
    expect(minecraftCommandStoragePath(parsePathSegment('foo'))).toBe('data/foo/command_storage.dat')
    expect(minecraftCommandStoragePath(parsePathSegment('foo'), 'the_nether')).toBe(
      'dimensions/minecraft/the_nether/data/foo/command_storage.dat',
    )
    expect(minecraftMapFilePath(parseMapId(7))).toBe('data/minecraft/maps/7.dat')
    expect(minecraftMapFilePath(parseMapId('8'))).toBe('data/minecraft/maps/8.dat')
    expect(minecraftLastIdPath()).toBe('data/minecraft/last_id.dat')
    expect(minecraftChunkTicketsPath()).toBe('data/minecraft/chunk_tickets.dat')
    expect(minecraftWorldResourcePackPath()).toBe('resourcepacks/resources.zip')
    expect(minecraftStructurePath(parsePathSegment('minecraft'), parseRelativePath('village/plains/houses/small_house_1'))).toBe(
      'generated/minecraft/structure/village/plains/houses/small_house_1.nbt',
    )
    // @ts-expect-error -- bypass the branded input type to test runtime rejection
    expect(() => minecraftPlayerDataPath('../player')).toThrow('player id must be a single safe path segment')
    // @ts-expect-error -- bypass the branded input type to test runtime rejection
    expect(() => minecraftStatsPath('.')).toThrow('player id must be a single safe path segment')
    // @ts-expect-error -- bypass the branded input type to test runtime rejection
    expect(() => minecraftAdvancementsPath('player/name')).toThrow('player id must be a single safe path segment')
    // @ts-expect-error -- bypass branded inputs to test runtime rejection
    expect(() => minecraftDataFilePath('..', 'raids.dat')).toThrow(
      'data namespace must be a single safe path segment',
    )
    // @ts-expect-error -- bypass branded inputs to test runtime rejection
    expect(() => minecraftDataFilePath('minecraft', '..')).toThrow(
      'data file name must be a single safe path segment',
    )
    // @ts-expect-error -- bypass the branded input type to test runtime rejection
    expect(() => minecraftMapFilePath(-1)).toThrow('map id must be a non-negative safe integer')
    // @ts-expect-error -- bypass the branded input type to test runtime rejection
    expect(() => minecraftMapFilePath(1.5)).toThrow('map id must be a non-negative safe integer')
    // @ts-expect-error -- bypass the branded input type to test runtime rejection
    expect(() => minecraftMapFilePath('-1')).toThrow('map id must be a non-negative safe integer')
    // @ts-expect-error -- bypass the branded input type to test runtime rejection
    expect(() => minecraftMapFilePath('map/name')).toThrow('map id must be a non-negative safe integer')
    // @ts-expect-error -- bypass branded inputs to test runtime rejection
    expect(() => minecraftStructurePath('minecraft', '../escape')).toThrow(
      'structure name must be a single safe path segment',
    )
    // @ts-expect-error -- bypass branded inputs to test runtime rejection
    expect(() => minecraftStructurePath('minecraft', 'village//house')).toThrow(
      'structure name must be a safe relative path',
    )
    // @ts-expect-error -- bypass branded inputs to test runtime rejection
    expect(() => minecraftWorldClockPath('../minecraft', 'day')).toThrow(
      'world clock namespace must be a single safe path segment',
    )
    // @ts-expect-error -- bypass branded inputs to test runtime rejection
    expect(() => minecraftWorldClockPath('minecraft', '../day')).toThrow(
      'world clock id must be a single safe path segment',
    )
  })
})
