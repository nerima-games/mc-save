import { ChunkAxis } from '@nerima-games/mc-kernel'
import { describe, expect, it, vi } from 'vitest'
import { encodeMinecraftJavaSave } from '../src/domain/minecraft-java-save-encode.js'
import {
  ANVIL_CHUNK_COUNT,
  anvilRegion,
  MinecraftJavaSaveError,
  nbtCompound,
  nbtDocument,
  nbtInt,
  type MinecraftJavaSave,
} from '../src/index.js'

const level = nbtDocument('Level', nbtCompound([['DataVersion', nbtInt(1)]]))

const baseSave = (): MinecraftJavaSave => ({
  level,
  playerData: [],
  playerStats: [],
  playerAdvancements: [],
  regions: [],
  dataFiles: [],
  worldClocks: [],
  structures: [],
  extraFiles: [],
})

describe('Minecraft Java save encode boundary, low-level failure paths', () => {
  it('wraps a non-MinecraftJavaSaveError raised by the NBT encoder', async () => {
    const source = baseSave()
    await expect(
      encodeMinecraftJavaSave(source, { compressedNbt: { nbt: { maxBytes: 1 } } }),
    ).rejects.toBeInstanceOf(MinecraftJavaSaveError)
    await expect(encodeMinecraftJavaSave(source, { compressedNbt: { nbt: { maxBytes: 1 } } })).rejects.toThrow(
      'level.dat',
    )
  })

  it('wraps a non-MinecraftJavaSaveError raised by the JSON encoder', async () => {
    const source: MinecraftJavaSave = {
      ...baseSave(),
      playerStats: [{ playerId: 'player-one', value: { score: 1 } }],
    }
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('stringify boundary failure')
    })
    try {
      await expect(encodeMinecraftJavaSave(source)).rejects.toBeInstanceOf(MinecraftJavaSaveError)
      await expect(encodeMinecraftJavaSave(source)).rejects.toThrow('stringify boundary failure')
    } finally {
      stringifySpy.mockRestore()
    }
  })

  it('wraps a non-MinecraftJavaSaveError raised by the region encoder', async () => {
    const chunks = new Array(ANVIL_CHUNK_COUNT).fill(null) as Array<{
      localX: number
      localZ: number
      timestamp: number
      compression: 'none'
      payload: Uint8Array
    } | null>
    chunks[0] = { localX: 0, localZ: 0, timestamp: 1, compression: 'none', payload: new Uint8Array([1, 2, 3]) }
    const source: MinecraftJavaSave = {
      ...baseSave(),
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
    await expect(encodeMinecraftJavaSave(source, { region: { maxRegionBytes: 1 } })).rejects.toBeInstanceOf(
      MinecraftJavaSaveError,
    )
    await expect(encodeMinecraftJavaSave(source, { region: { maxRegionBytes: 1 } })).rejects.toThrow('maxBytes')
  })

  it('guards the defensive session.lock encode failure path behind an already-validated save', async () => {
    vi.resetModules()
    vi.doMock('../src/domain/minecraft-save-files.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../src/domain/minecraft-save-files.js')>()
      return {
        ...actual,
        encodeMinecraftSessionLock: () => {
          throw new TypeError('forced session.lock encode failure')
        },
      }
    })
    try {
      const { encodeMinecraftJavaSave: encodeWithMockedSessionLock } = await import(
        '../src/domain/minecraft-java-save-encode.js'
      )
      // vi.resetModules() gives every module (including sibling ones like minecraft-java-save-errors.js) a
      // fresh instance, so the statically-imported MinecraftJavaSaveError class above is a different class
      // reference than the one this freshly re-imported encode module actually throws. Re-import it too.
      const { MinecraftJavaSaveError: FreshMinecraftJavaSaveError } = await import(
        '../src/domain/minecraft-java-save-errors.js'
      )
      const source: MinecraftJavaSave = { ...baseSave(), sessionLock: 1n }
      await expect(encodeWithMockedSessionLock(source)).rejects.toBeInstanceOf(FreshMinecraftJavaSaveError)
      await expect(encodeWithMockedSessionLock(source)).rejects.toThrow('forced session.lock encode failure')
    } finally {
      vi.doUnmock('../src/domain/minecraft-save-files.js')
      vi.resetModules()
    }
  })
})
