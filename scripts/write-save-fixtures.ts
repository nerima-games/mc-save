/**
 * Write the golden save fixtures. `pnpm fixtures:write`.
 *
 * docs/testing.md §4-2 requires two things together, and the second is why this
 * script exists rather than a directory of hand-typed JSON:
 *
 *   > **バージョンごとのゴールデン fixture が commit されている**
 *   >   - fixture を**書き出す仕組み**も同時にある（手書き JSON は禁止。
 *   >     「現行コードが出力するもの」ではなく「人が出力すると思ったもの」を固定してしまう）
 *
 * Every byte written below comes out of `encodeSave` applied to a frozen
 * historical format definition in `test/support/player-format-history.ts`. No
 * envelope is spelled as a literal anywhere, which is the property that makes the
 * committed files evidence rather than assertion.
 *
 * ---------------------------------------------------------------------------
 * This script is NOT a gate, and `pnpm verify` does not run it
 * ---------------------------------------------------------------------------
 *
 * `test/legacy-save-compat.test.ts` is the gate. It regenerates the fixtures in
 * memory and compares them against what is on disk, so drift fails the suite
 * without this script running in CI.
 *
 * The separation matters. If verification regenerated the files, then any change
 * that altered the output would rewrite the fixtures and go green — the failure
 * mode that makes a golden test worthless. Writing is a deliberate act by a human
 * who has decided the output SHOULD change; checking is automatic.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { FIXTURE_DIRECTORY, FORMAT_HISTORY } from '../test/support/player-format-history'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Serialise an envelope exactly as the test will re-serialise it.
 *
 * Two-space indent and a trailing newline: the file is committed, read in code
 * review, and compared byte-for-byte by the test, so the formatting is part of
 * the contract rather than a cosmetic choice. `JSON.stringify` orders keys by
 * insertion, and `saveEnvelope` builds them in a fixed order, so the output is
 * stable across runs and platforms.
 */
export const serialiseFixture = (envelope: unknown): string => `${JSON.stringify(envelope, null, 2)}\n`

const main = async (): Promise<void> => {
  const directory = path.join(repositoryRoot, FIXTURE_DIRECTORY)
  await mkdir(directory, { recursive: true })

  await Promise.all(
    FORMAT_HISTORY.map(async (entry) => {
      const envelope = await Effect.runPromise(entry.write())
      const target = path.join(directory, entry.fixtureFile)
      await writeFile(target, serialiseFixture(envelope), 'utf8')
      process.stdout.write(`wrote ${FIXTURE_DIRECTORY}/${entry.fixtureFile} (v${String(entry.version)})\n`)
    }),
  )

  process.stdout.write(`\n${String(FORMAT_HISTORY.length)} fixture(s) written. Commit them.\n`)
}

await main()
