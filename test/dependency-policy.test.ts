import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  allowedDirectDependencies,
  checkDeclaredDependencies,
  checkPolicyConfiguration,
  classifyImport,
  findBannedTimeSources,
  findTransitivePath,
  REPOSITORY_POLICY,
  TIME_SOURCE_ESCAPE_HATCH,
  type DeclaredDependencies,
} from '../scripts/check-dependency-whitelist'

const THIS_PACKAGE = '@nerima-games/mc-save'

const declared = (
  dependencies: ReadonlyArray<string>,
  devDependencies: ReadonlyArray<string> = [],
): DeclaredDependencies => ({
  dependencies: new Set(dependencies),
  devDependencies: new Set(devDependencies),
})

const shippedSite = (importedPackage: string) => ({
  importedPackage,
  filePath: 'domain/thing.ts',
  line: 1,
  isToolingOrTest: false,
})

describe('mc-save dependency policy', () => {
  it.effect('is this package, and allows no direct org dependency beyond kernel', () =>
    Effect.sync(() => {
      expect(REPOSITORY_POLICY.thisPackage).toBe(THIS_PACKAGE)
      expect([...allowedDirectDependencies()]).toStrictEqual([])
    }),
  )

  it.effect('has an internally consistent, acyclic configuration', () =>
    Effect.sync(() => {
      expect(checkPolicyConfiguration()).toStrictEqual([])
    }),
  )
})

describe('the 16-repository roster of plan.md §2.1', () => {
  it.effect('records every repository, so cycle detection sees the whole graph', () =>
    Effect.sync(() => {
      expect([...REPOSITORY_POLICY.dependencyGraph.keys()].sort()).toStrictEqual([
        '@nerima-games/mc-audio',
        '@nerima-games/mc-compose',
        '@nerima-games/mc-dev-meta',
        '@nerima-games/mc-kernel',
        '@nerima-games/mc-meshing',
        '@nerima-games/mc-noise',
        '@nerima-games/mc-physics',
        '@nerima-games/mc-playground-kit',
        '@nerima-games/mc-render',
        '@nerima-games/mc-save',
        '@nerima-games/mc-sim',
        '@nerima-games/mc-worldgen',
        '@nerima-games/mx-gameplay',
        '@nerima-games/mx-multiplayer',
        '@nerima-games/mx-redstone',
        '@nerima-games/mx-ui',
      ])
    }),
  )

  it.effect('never names kernel in a row, because kernel is universally importable', () =>
    Effect.sync(() => {
      for (const [, targets] of REPOSITORY_POLICY.dependencyGraph) {
        expect(targets.has('@nerima-games/mc-kernel')).toBe(false)
      }
      // Kernel still has a row of its own — an empty one. Without it, the
      // `checkPolicyConfiguration` rule that every edge target must be a known
      // node could not distinguish "kernel" from "typo".
      expect(REPOSITORY_POLICY.dependencyGraph.get('@nerima-games/mc-kernel')?.size).toBe(0)
    }),
  )

  it.effect('keeps the experience tier free of edges between its own members (plan.md §2.3-1)', () =>
    Effect.sync(() => {
      const experience = [
        '@nerima-games/mx-gameplay',
        '@nerima-games/mx-redstone',
        '@nerima-games/mx-ui',
        '@nerima-games/mx-multiplayer',
      ]

      for (const module of experience) {
        const targets = REPOSITORY_POLICY.dependencyGraph.get(module) ?? new Set<string>()
        for (const other of experience) {
          expect(targets.has(other)).toBe(false)
        }
      }
    }),
  )

  it.effect('gives mc-playground-kit no incoming runtime edge (plan.md §2.3-2)', () =>
    Effect.sync(() => {
      for (const [, targets] of REPOSITORY_POLICY.dependencyGraph) {
        expect(targets.has('@nerima-games/mc-playground-kit')).toBe(false)
      }
    }),
  )

  it.effect('records the graph mc-save sits under, even though mc-save depends on none of it', () =>
    Effect.sync(() => {
      // mc-save is a leaf, but two repositories depend on it. Losing those rows
      // would make a future cycle through mc-save invisible here.
      const dependents = [...REPOSITORY_POLICY.dependencyGraph.entries()]
        .filter(([, targets]) => targets.has(THIS_PACKAGE))
        .map(([source]) => source)
        .sort()

      expect(dependents).toStrictEqual(['@nerima-games/mc-sim', '@nerima-games/mc-worldgen'])
    }),
  )
})

describe('import gate', () => {
  it.effect('allows kernel without it appearing in any allowlist, provided package.json declares it', () =>
    Effect.sync(() => {
      expect(classifyImport(shippedSite('@nerima-games/mc-kernel'), declared(['@nerima-games/mc-kernel']))).toBeUndefined()
    }),
  )

  it.effect('rejects kernel when package.json does not declare it — the exemption is policy, not packaging', () =>
    Effect.sync(() => {
      const violation = classifyImport(shippedSite('@nerima-games/mc-kernel'), declared([]))
      expect(violation?.rule).toBe('undeclared-dependency')
    }),
  )

  it.effect('rejects a sibling mc-save does not depend on', () =>
    Effect.sync(() => {
      const violation = classifyImport(shippedSite('@nerima-games/mc-worldgen'), declared(['@nerima-games/mc-worldgen']))
      expect(violation?.rule).toBe('not-whitelisted')
    }),
  )

  /**
   * REGRESSION: no transitive closure (rule 3).
   *
   * Checked from mc-worldgen's row rather than mc-save's, because mc-save has no
   * dependencies of its own and so cannot demonstrate the rule. mc-worldgen may
   * import mc-save; that must not make mc-save's own dependents importable.
   */
  it.effect('finds the transitive path that makes reaching through a dependency a violation', () =>
    Effect.sync(() => {
      const path = findTransitivePath(
        REPOSITORY_POLICY.dependencyGraph,
        '@nerima-games/mc-compose',
        '@nerima-games/mc-save',
      )

      expect(path).toBeDefined()
      expect(path?.[0]).toBe('@nerima-games/mc-compose')
      expect(path?.[path.length - 1]).toBe('@nerima-games/mc-save')
      // compose reaches save only through an experience module and mc-sim, so
      // the path is at least four nodes long — and every one of those hops is a
      // hop compose is forbidden to shortcut.
      expect((path ?? []).length).toBeGreaterThanOrEqual(4)
    }),
  )

  /**
   * The `transitive-import` branch itself, exercised from mc-render's seat.
   *
   * From mc-save's own seat this rule is unreachable: it has no org dependencies
   * at all, so every foreign import is `not-whitelisted` instead. Borrowing
   * another repository's `thisPackage` — which is what `PolicyView` is for — is
   * the only way to run the most important rule in the gate rather than merely
   * declaring it.
   */
  it.effect('reports a transitive-closure violation, with the path, when viewed from mc-render', () =>
    Effect.sync(() => {
      const asRender = { ...REPOSITORY_POLICY, thisPackage: '@nerima-games/mc-render' }

      const violation = classifyImport(
        shippedSite('@nerima-games/mc-save'),
        declared(['@nerima-games/mc-save']),
        asRender,
      )

      expect(violation?.rule).toBe('transitive-import')
      expect(violation?.message).toContain('->')
      expect(violation?.message).toContain('not an import licence')
    }),
  )

  it.effect('still allows mc-render its own direct dependencies, so the view is not a blanket denial', () =>
    Effect.sync(() => {
      const asRender = { ...REPOSITORY_POLICY, thisPackage: '@nerima-games/mc-render' }

      expect(
        classifyImport(shippedSite('@nerima-games/mc-worldgen'), declared(['@nerima-games/mc-worldgen']), asRender),
      ).toBeUndefined()
    }),
  )

  it.effect('rejects mc-playground-kit in dependencies outright (plan.md §2.3-2)', () =>
    Effect.sync(() => {
      const violations = checkDeclaredDependencies(declared(['@nerima-games/mc-playground-kit']))

      expect(violations).toHaveLength(1)
      expect(violations[0]?.rule).toBe('dev-only-package-in-dependencies')
      expect(violations[0]?.message).toContain('devDependencies')
    }),
  )

  it.effect('accepts mc-playground-kit in devDependencies', () =>
    Effect.sync(() => {
      expect(checkDeclaredDependencies(declared([], ['@nerima-games/mc-playground-kit']))).toStrictEqual([])
    }),
  )

  it.effect('rejects importing mc-playground-kit from shipped source', () =>
    Effect.sync(() => {
      const violation = classifyImport(
        shippedSite('@nerima-games/mc-playground-kit'),
        declared([], ['@nerima-games/mc-playground-kit']),
      )
      expect(violation?.rule).toBe('dev-only-package-in-shipped-source')
    }),
  )
})

describe('time-source ban', () => {
  it.effect('flags Date.now(), new Date() and performance.now()', () =>
    Effect.sync(() => {
      const violations = findBannedTimeSources(
        ['const a = Date.now()', 'const b = new Date()', 'const c = performance.now()'].join('\n'),
        'domain/thing.ts',
      )

      expect(violations.map((violation) => violation.line).sort()).toStrictEqual([1, 2, 3])
      for (const violation of violations) {
        expect(violation.rule).toBe('banned-time-source')
      }
    }),
  )

  it.effect('ignores a clock read that only appears inside a comment or a string', () =>
    Effect.sync(() => {
      expect(
        findBannedTimeSources(['// do not call Date.now() here', 'const s = "Date.now()"'].join('\n'), 'domain/x.ts'),
      ).toStrictEqual([])
    }),
  )

  /**
   * The escape hatch matters specifically for this repository.
   *
   * A save file records when a world was last played, and that value can only
   * come from a wall clock. The reference implementation routed it correctly —
   * `Clock.currentTimeMillis` into `new Date(nowMs)`
   * (`packages/app/application/main/session-persist.ts:54` and `:82`) — and its
   * storage layer itself read no clock at all. mc-save keeps that property: the
   * timestamp is a parameter, and the hatch exists only for the eventual
   * adapter that implements a clock Port.
   */
  it.effect('exempts a line carrying the escape-hatch marker', () =>
    Effect.sync(() => {
      expect(
        findBannedTimeSources(`const now = Date.now() // ${TIME_SOURCE_ESCAPE_HATCH}`, 'domain/adapter.ts'),
      ).toStrictEqual([])
    }),
  )
})
