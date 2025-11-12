import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Run test files sequentially to avoid port conflicts
    fileParallelism: false,
    // Increase timeout for server tests in CI
    testTimeout: 15000,
    hookTimeout: 30000
  }
});
