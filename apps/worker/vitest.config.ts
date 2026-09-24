import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // Base PostgreSQL de test réelle, migrée par la même préparation que l'API.
    globalSetup: ['../api/test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
