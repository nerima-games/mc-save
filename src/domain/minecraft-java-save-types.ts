import type { ChunkAxis } from '@nerima-games/mc-kernel'
import type { AnvilRegion } from './anvil-region.js'
import type { MinecraftCompressedNbtOptions } from './minecraft-nbt-compression.js'
import type { NbtCodecOptions, NbtDocument } from './minecraft-nbt.js'
import type { MinecraftDimension, MinecraftRegionStorage } from './minecraft-paths.js'
import type { MinecraftRegionFilesOptions } from './minecraft-region-files.js'

export type MinecraftJsonValue =
  | null
  | boolean
  | string
  | number
  | ReadonlyArray<MinecraftJsonValue>
  | { readonly [key: string]: MinecraftJsonValue }

export type MinecraftJavaSaveFile = {
  readonly path: string
  readonly bytes: Uint8Array
}

export type MinecraftJavaPlayerDataFile = {
  readonly playerId: string
  readonly document: NbtDocument
}

export type MinecraftJavaPlayerJsonFile = {
  readonly playerId: string
  readonly value: MinecraftJsonValue
}

export type MinecraftJavaDataFile = {
  readonly namespace: string
  readonly name: string
  readonly dimension?: MinecraftDimension
  readonly document: NbtDocument
}

export type MinecraftJavaWorldClockFile = {
  readonly namespace: string
  readonly id: string
  readonly value: MinecraftJsonValue
}

export type MinecraftJavaStructureFile = {
  readonly namespace: string
  readonly name: string
  readonly document: NbtDocument
}

export type MinecraftJavaRegionFile = {
  readonly dimension: MinecraftDimension
  readonly storage: MinecraftRegionStorage
  readonly regionX: ChunkAxis
  readonly regionZ: ChunkAxis
  readonly region: AnvilRegion
}

export type MinecraftJavaSave = {
  readonly level: NbtDocument
  readonly levelBackup?: NbtDocument
  readonly sessionLock?: bigint
  readonly icon?: Uint8Array
  readonly playerData: ReadonlyArray<MinecraftJavaPlayerDataFile>
  readonly playerStats: ReadonlyArray<MinecraftJavaPlayerJsonFile>
  readonly playerAdvancements: ReadonlyArray<MinecraftJavaPlayerJsonFile>
  readonly regions: ReadonlyArray<MinecraftJavaRegionFile>
  readonly dataFiles: ReadonlyArray<MinecraftJavaDataFile>
  readonly worldClocks: ReadonlyArray<MinecraftJavaWorldClockFile>
  readonly structures: ReadonlyArray<MinecraftJavaStructureFile>
  readonly resourcePack?: Uint8Array
  readonly extraFiles: ReadonlyArray<MinecraftJavaSaveFile>
}

export type MinecraftJavaSaveOptions = {
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
  readonly nbt?: NbtCodecOptions
  readonly compressedNbt?: MinecraftCompressedNbtOptions
  readonly region?: MinecraftRegionFilesOptions
}
