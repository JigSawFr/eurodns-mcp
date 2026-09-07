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
        // Up 0.28 from 92.72 with the credential-less listing mode, whose every statement
        // is exercised — the refusal, the three surfaces that report it, and the shared
        // failure mapping that replaced two inline copies.
        statements: 93,
        // Branches sit below the rest because three `??` fallbacks in server.ts guard a
        // `createRequire` that only fails in a layout this package does not produce. Up
        // 0.81 from 86.7 with the same change: the compat catch and the portfolio
        // pre-check are new branches, both covered.
        branches: 87.51,
        // Up 0.12 from 93.18: `hasCredentials` twice over, the new error class and the two
        // failure helpers are all called; the DNS tools lost one local function to the
        // shared helper. The eighteen uncovered functions are still entry points and
        // signal handlers.
        functions: 93.3,
        lines: 93.93,
      },
    },
  },
});
