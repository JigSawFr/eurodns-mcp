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
      // Set at the measurement, not below it. This is a deliberate choice with a known
      // cost: nothing can slip, and an unrelated refactor that happens to remove a covered
      // line turns the build red even though nothing got worse.
      //
      // When that happens, there are exactly two honest moves. Cover what the refactor
      // left bare, or lower the number here in the same commit that made it true, saying
      // why. What is not a move is deleting a test to make the ratio work, or nudging the
      // floor down as a reflex — at that point the number stops meaning anything.
      thresholds: {
        statements: 92.25,
        // Branches sit below the rest because three `??` fallbacks in server.ts guard a
        // `createRequire` that only fails in a layout this package does not produce. Up
        // 1.10 from 85.11 across the role-intersection, result-rendering, handshake-
        // instructions, prompts and portfolio-cache commits, whose every branch is covered.
        branches: 86.21,
        functions: 92.96,
        lines: 93.22,
      },
    },
  },
});
