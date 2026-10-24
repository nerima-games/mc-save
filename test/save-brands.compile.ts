import { BlockAxis, WorldId } from '@nerima-games/mc-kernel'
import { ChunkAxis } from '@nerima-games/mc-kernel/domain/coordinates'
import { anvilRegionFileName as anvilRegionFileNameResult, saveKeyForWorld, type SaveKey } from '../src/index.js'
import { Result } from 'effect'

const worldId = WorldId('world/east')
const chunkAxis = ChunkAxis(0)
const blockAxis = BlockAxis(0)

export const validWorldKey: SaveKey = saveKeyForWorld(worldId, 'metadata')

// @ts-expect-error A ChunkAxis is not a WorldId at the save-key boundary.
saveKeyForWorld(chunkAxis, 'metadata')

export const validRegionFileName: string = Result.getOrThrow(anvilRegionFileNameResult({ cx: chunkAxis, cz: chunkAxis }))

// @ts-expect-error A BlockAxis is not a ChunkAxis at the Anvil path boundary.
anvilRegionFileName({ cx: blockAxis, cz: chunkAxis })
