import { defineConfig } from 'vitest/config';

// Pure protocol tests never connect to a database or call the real UPay service.
export default defineConfig({ test: { include: ['test/unit/**/*.test.ts'], testTimeout: 10000 } });
