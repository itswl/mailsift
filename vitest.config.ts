import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 每个测试文件独立进程：这些用例大量改 process.env，
    // 并行共享环境会互相污染
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
