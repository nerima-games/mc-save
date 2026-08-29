import type { Schema } from 'effect'

export type SaveFormat<A, I = A> = {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Schema<A, I>
}
