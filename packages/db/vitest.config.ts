import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.int.spec.ts'],
    environment: 'node',
    // Base PostgreSQL de test réelle, migrée par la préparation commune.
    globalSetup: ['../../apps/api/test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
