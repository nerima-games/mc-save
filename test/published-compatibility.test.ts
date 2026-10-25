import { readFileSync } from 'node:fs'
import { describe, expect } from 'vitest'
import { Effect, Result, Schema } from 'effect'
import { effect } from './support/effect-test.js'
import { applyUntrustedArgument } from './support/apply-untrusted-argument.js'
import { decodeSave, defineFormat, encodeSave } from '../src/domain/format.js'
import { sealSaveEnvelope, validateSaveEnvelope } from '../src/domain/integrity.js'
import {
  decodeMinecraftJavaSave,
  encodeMinecraftJavaSave,
  parseMinecraftJavaSaveFilePath,
} from '../src/index.js'
import { jsonExtensions } from './support/save-envelope.js'

const PublishedCompatibilityFixtureSchema = Schema.Struct({
  minecraft: Schema.Struct({
    files: Schema.Array(Schema.Struct({
      path: Schema.String,
      byteLength: Schema.Number,
      bytesBase64: Schema.String,
    })),
  }),
  envelope: Schema.Struct({
    value: Schema.Unknown,
    json: Schema.String,
    bytesBase64: Schema.String,
  }),
})

// Captured from the published 0.5.0 package; registry tarball shasum:
// cc4ef28d801f5e39287da7a241db008f9a6338ce.
const publishedFixture = Schema.decodeUnknownSync(PublishedCompatibilityFixtureSchema)(
  JSON.parse(readFileSync(new URL('./fixtures/published-mc-save-0.5.0.json', import.meta.url), 'utf8')),
)

const CompatibilityFormat = Result.getOrThrow(defineFormat({
  name: 'mc-save/compatibility-fixture',
  version: 1,
  schema: Schema.Struct({
    worldId: Schema.String,
    health: Schema.Number,
    inventory: Schema.Array(Schema.Struct({ id: Schema.String, count: Schema.Number })),
  }),
}))

describe('published 0.5.0 save compatibility', () => {
  effect('decodes and reproduces the published Minecraft and envelope bytes', () =>
    Effect.gen(function* () {
      expect(publishedFixture.minecraft.files).toHaveLength(19)
      expect(publishedFixture.minecraft.files.reduce((total, file) => total + file.byteLength, 0)).toBe(37_681)
      expect(Buffer.from(publishedFixture.envelope.bytesBase64, 'base64')).toHaveLength(392)

      const files = publishedFixture.minecraft.files.map((file) => ({
        path: Result.getOrThrow(parseMinecraftJavaSaveFilePath(file.path)),
        bytes: new Uint8Array(Buffer.from(file.bytesBase64, 'base64')),
      }))
      const decodedSave = yield* decodeMinecraftJavaSave(files)
      expect(decodedSave.level.name).toBe('Level')
      expect(decodedSave.playerData).toHaveLength(1)
      expect(decodedSave.regions).toHaveLength(3)

      const encodedFiles = yield* encodeMinecraftJavaSave(decodedSave)
      expect(encodedFiles.map((file) => ({
        path: file.path,
        byteLength: file.bytes.byteLength,
        bytesBase64: Buffer.from(file.bytes).toString('base64'),
      }))).toStrictEqual(publishedFixture.minecraft.files)

      const validatedEnvelope = yield* applyUntrustedArgument(
        validateSaveEnvelope,
        undefined,
        [publishedFixture.envelope.value],
      )
      const decodedState = yield* decodeSave(CompatibilityFormat, validatedEnvelope)
      expect(decodedState).toStrictEqual({
        worldId: 'world-日本-🌏',
        health: 17.5,
        inventory: [
          { id: 'minecraft:stone', count: 64 },
          { id: 'example:moon_shard', count: 3 },
        ],
      })

      const draft = yield* encodeSave(CompatibilityFormat, decodedState)
      const sealedEnvelope = Result.getOrThrow(sealSaveEnvelope(draft, jsonExtensions({
        application: 'compatibility-fixture',
        locale: '日本語🌍',
        binary: new Uint8Array([0, 127, 128, 255]),
      })))
      const envelopeJson = JSON.stringify(sealedEnvelope)
      expect(envelopeJson).toBe(publishedFixture.envelope.json)
      expect(Buffer.from(envelopeJson, 'utf8').toString('base64')).toBe(publishedFixture.envelope.bytesBase64)
    }),
  )
})
