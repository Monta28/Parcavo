import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HEALTH_CHECK_TIMEOUT_MS } from './modules/health/health.controller.js';

/**
 * Instructions d'exploitation (CDC 16.3, R-16.3-09) : la surveillance est confiée à un service extérieur au
 * serveur applicatif, sur des routes de santé qui existent, sont publiques (sans session) et renvoient 503
 * en cas de panne ; les procédures de mise à jour et de restauration contrôlent les mêmes routes.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

interface OpenApi {
  paths: Record<string, { get?: { security?: unknown[]; responses: Record<string, unknown> } }>;
}

describe('surveillance extérieure documentée sur des routes de santé réelles (CDC 16.3)', () => {
  const openapi = JSON.parse(read('docs/openapi.json')) as OpenApi;
  const installation = read('docs/installation.md');
  const monitoring = installation.slice(installation.indexOf('## 6. Surveillance extérieure'), installation.indexOf('## 7.'));

  it('installation §6 : service extérieur au VPS, deux sondes (prêt, worker) avec seuil d’alerte, panne totale du VPS couverte', () => {
    expect(monitoring).toContain('**extérieur au VPS**');
    expect(monitoring).toMatch(/alerte si la réponse n'est pas 200 pendant 5 minutes/);
    expect(monitoring).toContain('https://DOMAIN/api/v1/health/ready');
    expect(monitoring).toContain('https://DOMAIN/api/v1/health/worker');
    expect(monitoring).toMatch(/panne totale du VPS/);
    // Délai des contrôles documenté tel qu'appliqué : la sonde attend plus longtemps que le plus long contrôle.
    expect(monitoring).toContain(`Chaque contrôle de ces routes est borné à ${HEALTH_CHECK_TIMEOUT_MS / 1000} secondes`);
    expect(HEALTH_CHECK_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('chaque route de santé citée par les procédures existe, est publique et documente sa réponse 503', () => {
    const docs = ['docs/installation.md', 'docs/mise-a-jour.md', 'docs/sauvegarde-restauration.md', 'docs/exploitation.md', 'scripts/ops/restore-test.sh', 'scripts/tests/restart-persistence.sh'];
    const cited = new Set<string>();
    for (const file of docs) for (const m of read(file).matchAll(/\/api\/v1\/health\/[a-z]+/g)) cited.add(m[0]);
    for (const m of read('scripts/tests/restart-persistence.sh').matchAll(/health\/\$1|wait_http (\w+)/g)) if (m[1]) cited.add(`/api/v1/health/${m[1]}`);
    expect([...cited].sort()).toEqual(['/api/v1/health/live', '/api/v1/health/ready', '/api/v1/health/worker']);
    for (const path of cited) {
      const get = openapi.paths[path]?.get;
      expect(get, path).toBeDefined();
      expect(get?.security, path).toEqual([]);
      expect(Object.keys(get?.responses ?? {}), path).toContain('200');
      if (path !== '/api/v1/health/live') expect(Object.keys(get?.responses ?? {}), path).toContain('503');
    }
  });
});
