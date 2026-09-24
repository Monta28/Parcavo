import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Parcours navigateur (CDC 14.1) contre une pile réelle : API compilée + web compilé + PostgreSQL de test.
 * Prérequis : `pnpm build` à la racine et `docker compose up -d postgres-test`.
 */
const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 3900);
const API_PORT = Number(process.env['E2E_API_PORT'] ?? 3901);
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';
const repoRoot = resolve(import.meta.dirname, '../..');
const storageDir = resolve(repoRoot, process.env['E2E_STORAGE_DIR'] ?? 'tests/e2e/.storage');

export default defineConfig({
  testDir: './specs',
  globalSetup: './support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: WEB_ORIGIN,
    locale: 'fr-FR',
    timezoneId: 'Africa/Tunis',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium' },
  },
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      cwd: repoRoot,
      url: `http://localhost:${API_PORT}/api/v1/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL,
        PORT: String(API_PORT),
        APP_ORIGIN: WEB_ORIGIN,
        COOKIE_SECURE: 'false',
        STORAGE_DIR: storageDir,
        SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        LOG_LEVEL: 'warn',
        RATE_LIMIT_ENABLED: 'false',
      },
    },
    {
      command: `pnpm --filter @parc-auto/web start --port ${WEB_PORT}`,
      cwd: repoRoot,
      url: `${WEB_ORIGIN}/login`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: { API_INTERNAL_URL: `http://localhost:${API_PORT}`, NODE_ENV: 'production' },
    },
  ],
});
