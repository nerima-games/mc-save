import { Cause, Data, Effect, Schema } from 'effect'
import {
  SaveSliceIdSchema,
  SaveVersionSchema,
  type SaveSliceId,
  type SaveVersion,
} from '@nerima-games/mc-kernel/domain/module-contracts'
import type { SaveMigration, SaveSliceRegistration } from '@nerima-games/mc-kernel/domain/save-slices'

type EncodedSaveSlice = Readonly<{ version: SaveVersion; data: unknown }>
type EncodedSaveSliceEncoded = Readonly<{ version: number; data: unknown }>

export type EncodedSaveBundle = Readonly<Record<SaveSliceId, EncodedSaveSlice>>

const EncodedSaveSliceSchema: Schema.Codec<EncodedSaveSlice, EncodedSaveSliceEncoded> = Schema.Struct({
  version: SaveVersionSchema,
  data: Schema.Unknown,
})

const EncodedSaveBundleEntriesSchema = Schema.Record(Schema.String, EncodedSaveSliceSchema)

const decodeSaveBundleSnapshot = (snapshot: unknown): Effect.Effect<EncodedSaveBundle, Schema.SchemaError> =>
  Effect.gen(function* () {
    const entries = yield* Schema.decodeUnknownEffect(EncodedSaveBundleEntriesSchema)(snapshot)
    const bundle = Object.create(null) as Record<SaveSliceId, EncodedSaveSlice>
    for (const [key, value] of Object.entries(entries)) {
      const id = yield* Schema.decodeUnknownEffect(SaveSliceIdSchema)(key)
      bundle[id] = value
    }
    return bundle
  })

type SaveMigrationPathFields = Readonly<{
  id: SaveSliceId
  storedVersion: SaveVersion
  currentVersion: SaveVersion
}>
type SaveBundleSnapshotErrorFields = Readonly<{ reason: string }>
type SaveSliceBundleEntryMissingFields = Readonly<{ id: SaveSliceId }>
type SaveSliceNotRegisteredFields = Readonly<{ id: string }>

const SaveMigrationPathMissingBase: new (
  args: SaveMigrationPathFields,
) => Cause.YieldableError & { readonly _tag: 'SaveMigrationPathMissing' } & SaveMigrationPathFields =
  Data.TaggedError('SaveMigrationPathMissing')
export class SaveMigrationPathMissing extends SaveMigrationPathMissingBase {}

const SaveMigrationPathAmbiguousBase: new (
  args: SaveMigrationPathFields,
) => Cause.YieldableError & { readonly _tag: 'SaveMigrationPathAmbiguous' } & SaveMigrationPathFields =
  Data.TaggedError('SaveMigrationPathAmbiguous')
export class SaveMigrationPathAmbiguous extends SaveMigrationPathAmbiguousBase {}

const SaveBundleSnapshotErrorBase: new (
  args: SaveBundleSnapshotErrorFields,
) => Cause.YieldableError & { readonly _tag: 'SaveBundleSnapshotError' } & SaveBundleSnapshotErrorFields =
  Data.TaggedError('SaveBundleSnapshotError')
export class SaveBundleSnapshotError extends SaveBundleSnapshotErrorBase {}

const SaveSliceBundleEntryMissingBase: new (
  args: SaveSliceBundleEntryMissingFields,
) => Cause.YieldableError & { readonly _tag: 'SaveSliceBundleEntryMissing' } & SaveSliceBundleEntryMissingFields =
  Data.TaggedError('SaveSliceBundleEntryMissing')
export class SaveSliceBundleEntryMissing extends SaveSliceBundleEntryMissingBase {}

const SaveSliceNotRegisteredBase: new (
  args: SaveSliceNotRegisteredFields,
) => Cause.YieldableError & { readonly _tag: 'SaveSliceNotRegistered' } & SaveSliceNotRegisteredFields =
  Data.TaggedError('SaveSliceNotRegistered')
export class SaveSliceNotRegistered extends SaveSliceNotRegisteredBase {}

type AnySaveSliceRegistration = SaveSliceRegistration<Schema.Codec<any, any>, any, any>

type PreparedSaveSlice<Registration extends AnySaveSliceRegistration> = Readonly<{
  restore: () => Effect.Effect<
    void,
    RegistrationRestoreError<Registration>,
    RegistrationRequirements<Registration>
  >
}>

type RegistrationRestoreError<Registration> = Registration extends SaveSliceRegistration<
  infer _Slice,
  infer RestoreError,
  infer _Requirements
>
  ? RestoreError
  : never

type RegistrationRequirements<Registration> = Registration extends SaveSliceRegistration<
  infer _Slice,
  infer _RestoreError,
  infer Requirements
>
  ? Requirements
  : never

type RegistrationRequirementsOf<Registrations extends ReadonlyArray<AnySaveSliceRegistration>> =
  RegistrationRequirements<Registrations[number]>

type RestoreBundleError<Registrations extends ReadonlyArray<AnySaveSliceRegistration>> =
  | Schema.SchemaError
  | SaveBundleSnapshotError
  | SaveMigrationPathMissing
  | SaveMigrationPathAmbiguous
  | SaveSliceBundleEntryMissing
  | SaveSliceNotRegistered
  | RegistrationRestoreError<Registrations[number]>

type MigrationEdge = Readonly<{
  fromVersion: SaveVersion
  toVersion: SaveVersion
  migration: SaveMigration
}>

const migrationEdges = (migrations: ReadonlyArray<SaveMigration>): ReadonlyArray<MigrationEdge> =>
  migrations.map((migration) => ({
    fromVersion: migration.fromVersion,
    toVersion: migration.toVersion,
    migration,
  }))

export const decodeSaveBundle = (
  input: unknown,
): Effect.Effect<EncodedSaveBundle, Schema.SchemaError | SaveBundleSnapshotError> =>
  Effect.flatMap(
    Effect.try({
      try: () => structuredClone(input),
      catch: () => new SaveBundleSnapshotError({ reason: 'save bundle snapshot failed' }),
    }),
    decodeSaveBundleSnapshot,
  )

export const resolveSaveMigrationPath = ({
  id,
  migrations,
  fromVersion,
  toVersion,
}: {
  id: SaveSliceId
  migrations: ReadonlyArray<SaveMigration>
  fromVersion: SaveVersion
  toVersion: SaveVersion
}): Effect.Effect<
  ReadonlyArray<SaveMigration>,
  SaveMigrationPathMissing | SaveMigrationPathAmbiguous
> => {
  if (fromVersion === toVersion) return Effect.succeed([])

  const outgoing = new Map<number, Array<MigrationEdge>>()

  for (const edge of migrationEdges(migrations)) {
    if (edge.toVersion <= edge.fromVersion || edge.toVersion > toVersion) continue
    const edges = outgoing.get(edge.fromVersion)
    if (edges === undefined) outgoing.set(edge.fromVersion, [edge])
    else edges.push(edge)
  }

  const memo = new Map<number, ReadonlyArray<ReadonlyArray<MigrationEdge>>>()
  const pathsFrom = (version: number): ReadonlyArray<ReadonlyArray<MigrationEdge>> => {
    if (version === toVersion) return [[]]
    if (version > toVersion) return []

    const cached = memo.get(version)
    if (cached !== undefined) return cached

    const paths: Array<ReadonlyArray<MigrationEdge>> = []
    for (const edge of outgoing.get(version) ?? []) {
      for (const suffix of pathsFrom(edge.toVersion)) {
        paths.push([edge, ...suffix])
        if (paths.length > 1) break
      }
      if (paths.length > 1) break
    }

    memo.set(version, paths)
    return paths
  }

  const paths = pathsFrom(fromVersion)
  if (paths.length === 0) {
    return Effect.fail(new SaveMigrationPathMissing({ id, storedVersion: fromVersion, currentVersion: toVersion }))
  }
  if (paths.length > 1) {
    return Effect.fail(new SaveMigrationPathAmbiguous({ id, storedVersion: fromVersion, currentVersion: toVersion }))
  }
  return Effect.succeed(paths.flatMap((path) => path).map((edge) => edge.migration))
}

const encodeSaveSlice = <Registration extends AnySaveSliceRegistration>(
  registration: Registration,
): Effect.Effect<
  readonly [SaveSliceId, EncodedSaveSlice],
  Schema.SchemaError,
  RegistrationRequirements<Registration>
> =>
  Effect.flatMap(registration.snapshot, (value) =>
    Effect.map(Schema.encodeUnknownEffect(registration.schema)(value), (data) => [
      registration.id,
      { version: registration.version, data },
    ] as const),
  )

export const encodeSaveBundle = <
  const Registrations extends ReadonlyArray<AnySaveSliceRegistration>,
>(
  registrations: Registrations,
): Effect.Effect<EncodedSaveBundle, Schema.SchemaError, RegistrationRequirementsOf<Registrations>> =>
  Effect.map(
    Effect.forEach(registrations, encodeSaveSlice, { concurrency: 1 }),
    (entries): EncodedSaveBundle => {
      const bundle = Object.create(null) as Record<SaveSliceId, EncodedSaveSlice>
      for (const [id, entry] of entries) bundle[id] = entry
      return bundle
    },
  )

const applyMigrations = (
  data: unknown,
  migrations: ReadonlyArray<SaveMigration>,
): Effect.Effect<unknown, Schema.SchemaError> =>
  migrations.reduce<Effect.Effect<unknown, Schema.SchemaError>>(
    (current, migration) => Effect.flatMap(current, migration.run),
    Effect.succeed(data),
  )

const prepareSaveSlice = <Registration extends AnySaveSliceRegistration>(
  bundle: EncodedSaveBundle,
  registration: Registration,
): Effect.Effect<
  PreparedSaveSlice<Registration>,
  Schema.SchemaError | SaveMigrationPathMissing | SaveMigrationPathAmbiguous | SaveSliceBundleEntryMissing
> => {
  const savedSlice = bundle[registration.id]
  const validatedSlice = savedSlice !== undefined
    ? Effect.succeed(savedSlice)
    : Effect.fail(new SaveSliceBundleEntryMissing({ id: registration.id }))

  return Effect.flatMap(validatedSlice, (saved) =>
    Effect.flatMap(
      resolveSaveMigrationPath({
        id: registration.id,
        migrations: registration.migrations,
        fromVersion: saved.version,
        toVersion: registration.version,
      }),
      (path) =>
        Effect.flatMap(applyMigrations(saved.data, path), (data) =>
          Effect.map(Schema.decodeUnknownEffect(registration.schema)(data), (state) => ({
            restore: () => Effect.suspend(() => registration.restore(state)),
          })),
        ),
    ),
  )
}

export const restoreSaveBundle = <
  const Registrations extends ReadonlyArray<AnySaveSliceRegistration>,
>(
  bundleInput: unknown,
  registrations: Registrations,
): Effect.Effect<void, RestoreBundleError<Registrations>, RegistrationRequirementsOf<Registrations>> => {
  const registeredIds = new Set<string>(registrations.map(({ id }) => id))

  return Effect.flatMap(
    decodeSaveBundle(bundleInput),
    (bundle): Effect.Effect<
      void,
      RestoreBundleError<Registrations>,
      RegistrationRequirementsOf<Registrations>
    > => {
    const unregisteredId = Object.keys(bundle).find((id) => !registeredIds.has(id))
    if (unregisteredId !== undefined) {
      return Effect.fail(new SaveSliceNotRegistered({ id: unregisteredId }))
    }

    return Effect.flatMap(
      Effect.forEach(registrations, (registration) => prepareSaveSlice(bundle, registration), {
        concurrency: 1,
      }),
      (prepared) =>
        Effect.asVoid(
          Effect.forEach(
            prepared,
            ({ restore }) => restore(),
            { concurrency: 1 },
          ),
        ),
    )
    },
  )
}
