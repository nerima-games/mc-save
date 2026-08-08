import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as publicApi from '../src/index'
import type { StorageService } from '../src/index'

const expectedRuntimeExports = [
  'FIRST_VERSION',
  'SaveEnvelopeSchema',
  'saveEnvelope',
  'isFromFuture',
  'DEFAULT_MAX_SAVE_BYTES',
  'sealSaveEnvelope',
  'validateSaveEnvelope',
  'saveDurably',
  'loadDurably',
  'StorageError',
  'SaveDecodeError',
  'MigrationError',
  'DuplicateFormatError',
  'validateMigrationChain',
  'defineFormat',
  'encodeSave',
  'migrateToCurrent',
  'decodeSave',
  'SAVE_STORE_NAME',
  'INSERTION_INDEX_NAME',
  'STORE_LAYOUT_VERSION',
  'QUOTA_EXCEEDED_MARKER',
  'isQuotaExceeded',
  'makeIndexedDbStorage',
  'indexedDbStorageLayer',
  'saveTo',
  'loadFrom',
  'listFrom',
  'emptyRegistry',
  'registerFormat',
  'registerFormats',
  'lookupFormat',
  'describeRegistry',
  'SaveKey',
  'StoragePort',
  'makeInMemoryStorage',
  'InMemoryStorageLayer',
  'failingStorageLayer',
] as const

describe('public API', () => {
  it.effect('re-exports the domain runtime values from the barrel', () =>
    Effect.sync(() => {
      expect(Object.keys(publicApi).sort()).toEqual([...expectedRuntimeExports].sort())
    }),
  )

  it.effect('keeps the complete StorageService boundary available', () =>
    Effect.gen(function* () {
      const service = yield* publicApi.makeInMemoryStorage
      const typedService: StorageService = service

      expect(typeof typedService.get).toBe('function')
      expect(typeof typedService.put).toBe('function')
      expect(typeof typedService.remove).toBe('function')
      expect(typeof typedService.commitBatch).toBe('function')
      expect(typeof typedService.readBatch).toBe('function')
      expect(typedService).toHaveProperty('keys')
    }),
  )
})
