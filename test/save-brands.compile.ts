import { BlockAxis, WorldId } from '@nerima-games/mc-kernel'
import { ChunkAxis } from '@nerima-games/mc-kernel/domain/coordinates'
import {
  anvilRegionFileName as anvilRegionFileNameResult,
  saveKeyForWorld,
  SaveKeyNamespace,
  type SaveKey,
} from '../src/index.js'
import { Result } from 'effect'

const worldId = WorldId('world/east')
const chunkAxis = ChunkAxis(0)
const blockAxis = BlockAxis(0)
const metadataNamespace = Result.getOrThrow(SaveKeyNamespace.result('metadata'))

export const validWorldKey: SaveKey = Result.getOrThrow(saveKeyForWorld(worldId, metadataNamespace))

// @ts-expect-error A ChunkAxis is not a WorldId at the save-key boundary.
saveKeyForWorld(chunkAxis, metadataNamespace)

export const validRegionFileName: string = Result.getOrThrow(anvilRegionFileNameResult({ cx: chunkAxis, cz: chunkAxis }))

// @ts-expect-error A BlockAxis is not a ChunkAxis at the Anvil path boundary.
anvilRegionFileNameResult({ cx: blockAxis, cz: chunkAxis })
