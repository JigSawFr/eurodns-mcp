import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // The generated tool surface is derived from the OpenAPI document by `npm run gen`,
      // and a reproducibility check already guards it. Measuring it would report on the
      // generator's output rather than on code anyone writes.
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
      reporter: ['text-summary', 'lcov'],
      // Measured, then floored a few points below — 87.9 / 76.2 / 91.4 / 88.8 at the time
      // of writing. A threshold set at the current number turns every unrelated refactor
      // red; one invented out of ambition fails without protecting anything. These catch a
      // real drop and tolerate ordinary movement.
      thresholds: {
        statements: 85,
        branches: 73,
        functions: 88,
        lines: 85,
      },
    },
  },
});
