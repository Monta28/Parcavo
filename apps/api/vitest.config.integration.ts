import { defineConfig } from 'vitest/config';

// Tests d'intégration : vraie base PostgreSQL (docker-compose.yml, service postgres-test).
// Exécution séquentielle : les tests partagent une base et vérifient la concurrence réelle
// par des requêtes HTTP parallèles au sein d'un même test.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.int.spec.ts'],
    environment: 'node',
    globalSetup: ['./test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
