import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://gudex:gudex@localhost:5442/gudex_test';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    // Все тесты работают с одной тестовой базой — по очереди.
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
    },
  },
});
