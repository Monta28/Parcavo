import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { seedE2E } from './seed-e2e.js';

export default async function globalSetup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';
  // Nom de la base (chemin de l'URL, seul élément retenu par pg et Prisma) : ni l'hôte, ni l'utilisateur, ni un paramètre.
  const database = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    } catch {
      return '';
    }
  })();
  if (!/^parc_auto_test/.test(database)) throw new Error('TEST_DATABASE_URL doit cibler la base parc_auto_test.');
  const repoRoot = resolve(import.meta.dirname, '../../..');
  execSync('pnpm exec prisma migrate deploy', { cwd: resolve(repoRoot, 'packages/db'), stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
  await seedE2E(url);
}
