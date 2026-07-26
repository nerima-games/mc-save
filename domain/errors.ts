/**
 * The errors that cross mc-save's boundary.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * The reference implementation had exactly one error type reach callers —
 * `StorageError` (`packages/block/domain/errors.ts:6-14`), with `IndexedDBError`
 * mapped into it by `packages/world/infrastructure/storage-error-mapping.ts:7-10`.
 * That collapsing was right for the adapter but wrong for the toolkit: it made
 * "the disk is full", "this save is from a newer build" and "migration 2→3 threw"
 * indistinguishable at the call site, so the UI could only ever say
 * `"${worldId} (corrupt)"` (`packages/presentation/menu/main-menu-handlers.ts:137-142`).
 *
 * Here the three are separate types from the start, because the *caller's*
 * correct response differs: retry, refuse-and-warn, and report-a-bug.
 */
import { Data } from 'effect'

/**
 * The storage medium failed. This is the retryable one — the reference wrapped
 * it in `Schedule.exponential(100ms)` with 3 attempts, aborting on
 * `QuotaExceededError` (`storage-error-mapping.ts:12-19`), and that policy
 * belongs on top of this type rather than inside it.
 */
export class StorageError extends Data.TaggedError('StorageError')<{
  readonly operation: string
  readonly key?: string
  readonly cause?: unknown
}> {
  override get message(): string {
    return `storage operation "${this.operation}" failed${this.key === undefined ? '' : ` for key "${this.key}"`}`
  }
}

/**
 * The bytes came back but do not mean what this build expects.
 *
 * `version` is the version recorded in the envelope, which is the single most
 * useful thing to put in a bug report and the thing the reference implementation
 * threw away.
 */
export class SaveDecodeError extends Data.TaggedError('SaveDecodeError')<{
  readonly format: string
  readonly version: number
  readonly reason: string
  readonly cause?: unknown
}> {
  override get message(): string {
    return `save format "${this.format}" v${String(this.version)} failed to decode: ${this.reason}`
  }
}

/**
 * A migration step exists, ran, and did not produce something the next step (or
 * the final schema) accepts.
 *
 * Distinct from `SaveDecodeError` on purpose: a decode failure usually means a
 * corrupt or foreign file, whereas this always means *our own* migration code is
 * wrong. Conflating them is how a broken migration ships as "some users have
 * corrupt saves".
 */
export class MigrationError extends Data.TaggedError('MigrationError')<{
  readonly format: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly reason: string
  readonly cause?: unknown
}> {
  override get message(): string {
    return (
      `migration ${String(this.fromVersion)} → ${String(this.toVersion)} of save format ` +
      `"${this.format}" failed: ${this.reason}`
    )
  }
}

/** Registering two formats under one name. A programmer error, surfaced as a value. */
export class DuplicateFormatError extends Data.TaggedError('DuplicateFormatError')<{
  readonly format: string
}> {
  override get message(): string {
    return `save format "${this.format}" is already registered`
  }
}
