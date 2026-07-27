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
exported declarations: 49
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

### INSERTION_INDEX_NAME  `const`

```ts
const INSERTION_INDEX_NAME = "by-insertion";
```

### IdbDatabase  `type`

```ts
type IdbDatabase = {
    readonly name: string;
    readonly version: number;
    readonly objectStoreNames: IdbStringList;
    readonly createObjectStore: (name: string, options?: {
        readonly keyPath?: string;
    }) => IdbObjectStore;
    readonly transaction: (storeNames: string, mode?: 'readonly' | 'readwrite') => IdbTransaction;
    readonly close: () => void;
    onversionchange: ((event: never) => void) | null;
};
```

### IdbDomException  `type`

```ts
type IdbDomException = {
    readonly name: string;
    readonly message: string;
};
```

### IdbFactory  `type`

```ts
type IdbFactory = {
    readonly open: (name: string, version?: number) => IdbOpenRequest;
    readonly databases?: () => Promise<ReadonlyArray<{
        readonly name?: string;
        readonly version?: number;
    }>>;
};
```

### IdbIndex  `type`

```ts
type IdbIndex = {
    readonly getAllKeys: (query?: null, count?: number) => IdbRequest;
    readonly openCursor: (query?: null, direction?: 'prev') => IdbRequest;
};
```

### IdbObjectStore  `type`

```ts
type IdbObjectStore = {
    readonly get: (key: string) => IdbRequest;
    readonly put: (value: unknown) => IdbRequest;
    readonly delete: (key: string) => IdbRequest;
    readonly index: (name: string) => IdbIndex;
    readonly createIndex: (name: string, keyPath: string) => unknown;
};
```

### IdbOpenRequest  `type`

```ts
type IdbOpenRequest = IdbRequest & {
    readonly result: IdbDatabase;
    onupgradeneeded: ((event: never) => void) | null;
    onblocked: ((event: never) => void) | null;
};
```

### IdbRequest  `type`

```ts
type IdbRequest = {
    readonly result: unknown;
    readonly error: IdbDomException | null;
    onsuccess: ((event: never) => void) | null;
    onerror: ((event: never) => void) | null;
};
```

### IdbStringList  `type`

```ts
type IdbStringList = {
    readonly length: number;
    readonly contains: (name: string) => boolean;
    readonly item: (index: number) => string | null;
};
```

### IdbTransaction  `type`

```ts
type IdbTransaction = {
    readonly objectStore: (name: string) => IdbObjectStore;
    readonly abort: () => void;
    readonly error: IdbDomException | null;
    oncomplete: ((event: never) => void) | null;
    onerror: ((event: never) => void) | null;
    onabort: ((event: never) => void) | null;
};
```

### InMemoryStorageLayer  `const`

```ts
const InMemoryStorageLayer: Layer.Layer<StoragePort>;
```

### IndexedDbStorageOptions  `type`

```ts
type IndexedDbStorageOptions = {
    readonly factory: IdbFactory;
    readonly databaseName: string;
};
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

### QUOTA_EXCEEDED_MARKER  `const`

```ts
const QUOTA_EXCEEDED_MARKER = ":quota-exceeded";
```

### SAVE_STORE_NAME  `const`

```ts
const SAVE_STORE_NAME = "saves";
```

### STORE_LAYOUT_VERSION  `const`

```ts
const STORE_LAYOUT_VERSION = 1;
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

### indexedDbStorageLayer  `const`

```ts
const indexedDbStorageLayer: (options: IndexedDbStorageOptions) => Layer.Layer<StoragePort, StorageError>;
```

### isFromFuture  `const`

```ts
const isFromFuture: (envelope: SaveEnvelope, currentVersion: number) => boolean;
```

### isQuotaExceeded  `const`

```ts
const isQuotaExceeded: (error: StorageError) => boolean;
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

### makeIndexedDbStorage  `const`

```ts
const makeIndexedDbStorage: (options: IndexedDbStorageOptions) => Effect.Effect<StorageService, StorageError, Scope.Scope>;
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
