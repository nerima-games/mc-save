/**
 * Turn a `T | undefined` that the surrounding code has already proved defined
 * into a `T`, without a non-null assertion.
 *
 * The callers are places where TypeScript cannot see the proof that a value
 * exists — an array index inside a length-checked loop, a mandatory regex
 * capture group after the whole pattern matched — so `noUncheckedIndexedAccess`
 * still types the read as possibly `undefined`. Throwing here names a defect in
 * this module, never a bad input: every caller has already rejected bad input
 * with its own typed error before reaching this line.
 */
export const assertDefined = <T,>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what)
  return value
}
