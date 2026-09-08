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
        // Up 0.22 from 93.42 with the second consolidation: the get-or-search, choose-among
        // and subscription routers are each driven through every branch by
        // `tests/composites.test.ts`, and the upsert's `append` path by `tests/dns.test.ts`.
        statements: 93.64,
        // Branches sit below the rest because three `??` fallbacks in server.ts guard a
        // `createRequire` that only fails in a layout this package does not produce. Up
        // 0.71 from 87.51 with the same change — and two branches no call could reach were
        // removed rather than left to count against the number. Up 0.13 with the routers
        // above, each of whose branches has a test that records the upstream request.
        branches: 88.35,
        // Up 0.51 from 93.3: the three composite factories, their routers, `areaFor`,
        // `titleFor` and the two resolvers are all called. The eighteen uncovered functions
        // are still entry points and signal handlers. Up 0.22 with three more factories.
        functions: 94.03,
        lines: 94.44,
      },
    },
  },
});
