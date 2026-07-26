# API lock — @nerima-games/mc-save

<!-- ------------------------------------------------------------------------- -->
<!-- GENERATED FILE. Do not edit by hand.                                      -->
<!--                                                                           -->
<!-- Regenerate with `pnpm api:update`. `pnpm api:check`, which `pnpm verify`  -->
<!-- runs, fails when this file is stale.                                      -->
<!--                                                                           -->
<!-- Every line below is part of the published surface of this package. A diff -->
<!-- here is a diff in what consumers can see, and is the thing plan.md §6     -->
<!-- Step 0-3 asks to be reviewed as a diff. See scripts/api-lock.ts for how   -->
<!-- it is produced and why it is produced this way.                           -->
<!-- ------------------------------------------------------------------------- -->

format: 1
exported declarations: 32
supporting declarations: 5

## Exported

### AnySaveFormat  `type`

```ts
type AnySaveFormat = SaveFormat<any, any>;
```

### DuplicateFormatError  `class`

```ts
class DuplicateFormatError extends DuplicateFormatError_base<{
    readonly format: string;
}> {
    get message(): string;
}
```

### FIRST_VERSION  `const`

```ts
const FIRST_VERSION = 1;
```

### FormatRegistry  `type`

```ts
type FormatRegistry = ReadonlyMap<string, AnySaveFormat>;
```

### InMemoryStorageLayer  `const`

```ts
const InMemoryStorageLayer: Layer.Layer<StoragePort>;
```

### Migration  `type`

```ts
type Migration = {
    readonly from: number;
    readonly describe: string;
    readonly migrate: (payload: unknown) => Effect.Effect<unknown, string>;
};
```

### MigrationError  `class`

```ts
class MigrationError extends MigrationError_base<{
    readonly format: string;
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly reason: string;
    readonly cause?: unknown;
}> {
    get message(): string;
}
```

### SaveDecodeError  `class`

```ts
class SaveDecodeError extends SaveDecodeError_base<{
    readonly format: string;
    readonly version: number;
    readonly reason: string;
    readonly cause?: unknown;
}> {
    get message(): string;
}
```

### SaveEnvelope  `type`

```ts
type SaveEnvelope = {
    readonly format: string;
    readonly version: number;
    readonly payload: unknown;
};
```

### SaveEnvelopeSchema  `const`

```ts
const SaveEnvelopeSchema: Schema.Schema<SaveEnvelope>;
```

### SaveFormat  `type`

```ts
type SaveFormat<A, I = A> = {
    readonly name: string;
    readonly version: number;
    readonly schema: Schema.Schema<A, I>;
    readonly migrations: ReadonlyArray<Migration>;
};
```

### SaveKey  `const`

```ts
const SaveKey: Brand.Brand.Constructor<SaveKey>;
```

### SaveKey  `type`

```ts
type SaveKey = string & Brand.Brand<'SaveKey'>;
```

### StorageError  `class`

```ts
class StorageError extends StorageError_base<{
    readonly operation: string;
    readonly key?: string;
    readonly cause?: unknown;
}> {
    get message(): string;
}
```

### StoragePort  `class`

```ts
class StoragePort extends StoragePort_base {
}
```

### StorageService  `type`

```ts
type StorageService = {
    readonly get: (key: SaveKey) => Effect.Effect<Option.Option<SaveEnvelope>, StorageError>;
    readonly put: (key: SaveKey, envelope: SaveEnvelope) => Effect.Effect<void, StorageError>;
    readonly remove: (key: SaveKey) => Effect.Effect<void, StorageError>;
    readonly keys: Effect.Effect<ReadonlyArray<SaveKey>, StorageError>;
};
```

### decodeSave  `const`

```ts
const decodeSave: <A, I>(format: SaveFormat<A, I>, envelope: SaveEnvelope) => Effect.Effect<A, SaveDecodeError | MigrationError>;
```

### defineFormat  `const`

```ts
const defineFormat: <A, I>(spec: {
    readonly name: string;
    readonly version: number;
    readonly schema: Schema.Schema<A, I>;
    readonly migrations?: ReadonlyArray<Migration>;
}) => SaveFormat<A, I>;
```

### describeRegistry  `const`

```ts
const describeRegistry: (registry: FormatRegistry) => ReadonlyArray<{
    readonly name: string;
    readonly version: number;
}>;
```

### emptyRegistry  `const`

```ts
const emptyRegistry: FormatRegistry;
```

### encodeSave  `const`

```ts
const encodeSave: <A, I>(format: SaveFormat<A, I>, value: A) => Effect.Effect<SaveEnvelope, SaveDecodeError>;
```

### failingStorageLayer  `const`

```ts
const failingStorageLayer: (operation: string) => Layer.Layer<StoragePort>;
```

### isFromFuture  `const`

```ts
const isFromFuture: (envelope: SaveEnvelope, currentVersion: number) => boolean;
```

### loadFrom  `const`

```ts
const loadFrom: <A, I>(format: SaveFormat<A, I>, key: SaveKey) => Effect.Effect<Option.Option<A>, StorageError | SaveDecodeError | MigrationError, StoragePort>;
```

### lookupFormat  `const`

```ts
const lookupFormat: (registry: FormatRegistry, name: string) => Option.Option<AnySaveFormat>;
```

### makeInMemoryStorage  `const`

```ts
const makeInMemoryStorage: Effect.Effect<StorageService>;
```

### migrateToCurrent  `const`

```ts
const migrateToCurrent: <A, I>(format: SaveFormat<A, I>, envelope: SaveEnvelope) => Effect.Effect<unknown, MigrationError>;
```

### registerFormat  `const`

```ts
const registerFormat: (registry: FormatRegistry, format: AnySaveFormat) => Either.Either<FormatRegistry, DuplicateFormatError>;
```

### registerFormats  `const`

```ts
const registerFormats: (registry: FormatRegistry, formats: ReadonlyArray<AnySaveFormat>) => Either.Either<FormatRegistry, DuplicateFormatError>;
```

### saveEnvelope  `const`

```ts
const saveEnvelope: (format: string, version: number, payload: unknown) => SaveEnvelope;
```

### saveTo  `const`

```ts
const saveTo: <A, I>(format: SaveFormat<A, I>, key: SaveKey, value: A) => Effect.Effect<void, StorageError | SaveDecodeError, StoragePort>;
```

### validateMigrationChain  `const`

```ts
const validateMigrationChain: (spec: {
    readonly name: string;
    readonly version: number;
    readonly migrations: ReadonlyArray<Migration>;
}) => ReadonlyArray<string>;
```

## Supporting declarations

Not exported from the barrel, but named by the signatures above, so a
consumer is exposed to them. `Context.Tag` service classes emit their real
type onto one of these.

### DuplicateFormatError_base  `const`

```ts
const DuplicateFormatError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "DuplicateFormatError";
} & Readonly<A>;
```

### MigrationError_base  `const`

```ts
const MigrationError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "MigrationError";
} & Readonly<A>;
```

### SaveDecodeError_base  `const`

```ts
const SaveDecodeError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "SaveDecodeError";
} & Readonly<A>;
```

### StorageError_base  `const`

```ts
const StorageError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "StorageError";
} & Readonly<A>;
```

### StoragePort_base  `const`

```ts
const StoragePort_base: Context.TagClass<StoragePort, "@nerima-games/mc-save/StoragePort", StorageService>;
```
