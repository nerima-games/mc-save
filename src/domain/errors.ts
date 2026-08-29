import { Data } from 'effect'

export class StorageError extends Data.TaggedError('StorageError')<{
  readonly operation: string
  readonly key?: string
  readonly cause?: unknown
}> {
  override get message(): string {
    return `storage operation "${this.operation}"${this.key === undefined ? '' : ` for key "${this.key}"`} failed`
  }
}

export class SaveDecodeError extends Data.TaggedError('SaveDecodeError')<{
  readonly format: string
  readonly version: number
  readonly reason: string
  readonly cause?: unknown
}> {
  override get message(): string {
    return `save format "${this.format}" v${this.version} failed to decode: ${this.reason}`
  }
}

export class DuplicateFormatError extends Data.TaggedError('DuplicateFormatError')<{
  readonly format: string
}> {
  override get message(): string {
    return `save format "${this.format}" is already registered`
  }
}
