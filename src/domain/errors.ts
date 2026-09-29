import { Data } from 'effect'
import type * as Cause from 'effect/Cause'

// Every error class in this package binds its tag constructor to a name and
// annotates the resolved shape, because `--isolatedDeclarations` (see
// tsconfig.base.json) refuses an expression in an `extends` clause. The tag
// constructor is a function call, so `extends Data.TaggedError('X')<{...}>`
// cannot be written directly.

type StorageErrorFields = {
  readonly operation: string
  readonly key?: string
  readonly cause?: unknown
}

const StorageErrorBase: new (
  args: StorageErrorFields,
) => Cause.YieldableError & { readonly _tag: 'StorageError' } & Readonly<StorageErrorFields> =
  Data.TaggedError('StorageError')

export class StorageError extends StorageErrorBase {
  override get message(): string {
    return `storage operation "${this.operation}"${this.key === undefined ? '' : ` for key "${this.key}"`} failed`
  }
}

type SaveDecodeErrorFields = {
  readonly format: string
  readonly version: number
  readonly reason: string
  readonly cause?: unknown
}

const SaveDecodeErrorBase: new (
  args: SaveDecodeErrorFields,
) => Cause.YieldableError & { readonly _tag: 'SaveDecodeError' } & Readonly<SaveDecodeErrorFields> =
  Data.TaggedError('SaveDecodeError')

export class SaveDecodeError extends SaveDecodeErrorBase {
  override get message(): string {
    return `save format "${this.format}" v${this.version} failed to decode: ${this.reason}`
  }
}

type DuplicateFormatErrorFields = {
  readonly format: string
}

const DuplicateFormatErrorBase: new (
  args: DuplicateFormatErrorFields,
) => Cause.YieldableError & { readonly _tag: 'DuplicateFormatError' } & Readonly<DuplicateFormatErrorFields> =
  Data.TaggedError('DuplicateFormatError')

export class DuplicateFormatError extends DuplicateFormatErrorBase {
  override get message(): string {
    return `save format "${this.format}" is already registered`
  }
}
