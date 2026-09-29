import { BlockAxis, ChunkAxis, WorldId } from '@nerima-games/mc-kernel'
import { anvilRegionFileName, saveKeyForWorld, type SaveKey } from '../src/index.js'

const worldId = WorldId('world/east')
const chunkAxis = ChunkAxis(0)
const blockAxis = BlockAxis(0)

export const validWorldKey: SaveKey = saveKeyForWorld(worldId, 'metadata')

// @ts-expect-error A ChunkAxis is not a WorldId at the save-key boundary.
saveKeyForWorld(chunkAxis, 'metadata')

export const validRegionFileName: string = anvilRegionFileName({ cx: chunkAxis, cz: chunkAxis })

// @ts-expect-error A BlockAxis is not a ChunkAxis at the Anvil path boundary.
anvilRegionFileName({ cx: blockAxis, cz: chunkAxis })
