import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    maxWorkers: '50%',
    isolate: true,
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.git/**'],
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 5000,
    slowTestThreshold: 300,
    fileParallelism: true,
    sequence: {
      seed: 0,
      hooks: 'stack',
    },
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      enabled: false,
      include: ['src/index.ts', 'src/domain/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/*.config.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        // PURE_TYPE: declarations only, zero executable statements. v8 reports
        // this kind of file as 0% rather than 100% (same quirk documented in
        // mc-kernel's vitest.config.ts), which would make the headline number
        // meaningless. This file's contract is proved by `pnpm typecheck`
        // (test/fixtures/indexeddb-surface.ts compiles it against the real
        // `lib.dom.d.ts`) rather than by executing it.
        'src/domain/indexeddb-surface.ts',
      ],
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Every executable path in this small package is part of the public
      // contract. Keep all four metrics at 100% so a new branch cannot ship
      // without an executable test.
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
  esbuild: {
    target: 'node24',
    format: 'esm',
    platform: 'node',
  },
})
