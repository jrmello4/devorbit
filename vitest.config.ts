import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'dist-electron'],
    testTimeout: 30000,
    hookTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,

    coverage: {
      provider: 'v8',
      include: ['src/main/**', 'src/shared/**', 'src/preload/**', 'src/renderer/src/**'],
      exclude: [
        'src/renderer/src/types.ts',
        '**/*.d.ts',
        'src/**/index.ts',
        'src/**/*.test.*',
        'src/**/__tests__/**',
      ],
      reportsDirectory: 'coverage/',
      reporter: ['text', 'html'],
      // Keep the report available even when unrelated tests fail
      // (parallel workers may land WIP in the same tree).
      reportOnFailure: true,
      thresholds: {
        // Baseline measured on the current suite (2026-09-29):
        // lines 62.16%, branches 53.25%, functions 52.69%, statements 59.15%.
        // Thresholds = floor(baseline) - 1; raise as coverage grows.
        lines: 61,
        branches: 52,
        functions: 51,
        statements: 58,
      },
    },
  },
})
