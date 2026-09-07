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
        // Up 0.42 from 93 with the consolidated surface: the composite routing, the shared
        // `executeOperation`, the parameter and body resolvers and the delete-by-id branch are
        // all driven by `tests/composites.test.ts` and `tests/descriptions.test.ts`.
        statements: 93.42,
        // Branches sit below the rest because three `??` fallbacks in server.ts guard a
        // `createRequire` that only fails in a layout this package does not produce. Up
        // 0.71 from 87.51 with the same change — and two branches no call could reach were
        // removed rather than left to count against the number.
        branches: 88.22,
        // Up 0.51 from 93.3: the three composite factories, their routers, `areaFor`,
        // `titleFor` and the two resolvers are all called. The eighteen uncovered functions
        // are still entry points and signal handlers.
        functions: 93.81,
        lines: 94.24,
      },
    },
  },
});
