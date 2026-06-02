import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    // .claude excluded so local agent worktree checkouts don't add
    // foreign copies of the suite to the run (mirrors .prettierignore)
    exclude: ['**/node_modules/**', 'dist', '.sdk-under-test', '.claude/**'],
    // Run test files sequentially to avoid port conflicts
    fileParallelism: false,
    // Increase timeout for server tests in CI
    testTimeout: 15000,
    hookTimeout: 30000
  }
});
