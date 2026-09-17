import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Run each test file in its own process: these tests mutate process.env heavily,
    // and sharing it in parallel would cause cross-test contamination.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
