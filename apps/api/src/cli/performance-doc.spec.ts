import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CDC_LOAD_TARGET } from './seed-load.js';

/**
 * Documentation du dimensionnement (CDC 17.2 : « documenter le matériel, le jeu de données et le scénario de
 * charge ») : docs/performance.md est confrontée au code du jeu (seed-load.ts), au script de charge
 * (load-test.mjs) et à ses propres résultats bruts.
 */
const root = resolve(import.meta.dirname, '../../../..');
const doc = readFileSync(resolve(root, 'docs/performance.md'), 'utf8');
const script = readFileSync(resolve(root, 'scripts/tests/load-test.mjs'), 'utf8');
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

describe('docs/performance.md (CDC 17.2)', () => {
  it('documente le matériel, le jeu de données, le scénario, les commandes, les résultats bruts et les limites', () => {
    for (const heading of ['## 2. Matériel de la mesure', '## 3. Jeu de données', '## 4. Scénario de charge', '## 5. Commandes', '## 6. Résultats bruts', '## 8. Limites']) {
      expect(doc, heading).toContain(heading);
    }
    expect(doc).toMatch(/\d+ processeurs logiques/);
    expect(doc).toMatch(/[\d ]+ Mio au total/);
    expect(doc).toMatch(/PostgreSQL \| 16\.\d+/);
    expect(doc).toContain('hypothèse de dimensionnement');
  });

  it('volumes du jeu décrits = cible du CDC codée dans seed-load.ts', () => {
    expect(doc).toContain(`| Sociétés | ${CDC_LOAD_TARGET.companies} |`);
    expect(doc).toContain(`| Véhicules | ${thousands(CDC_LOAD_TARGET.vehicles)} |`);
    expect(doc).toContain(`| Conducteurs | ${thousands(CDC_LOAD_TARGET.drivers)} |`);
    expect(doc).toContain(`| Relevés kilométriques | ${thousands(CDC_LOAD_TARGET.readings)} |`);
    expect(doc).toContain(`| Comptes (sessions) | ${CDC_LOAD_TARGET.sessions} |`);
  });

  it('seuils et sessions du scénario = ceux du script de charge ; commandes présentes dans le dépôt', () => {
    expect(script).toContain('const READ_P95_LIMIT_MS = 2_000;');
    expect(script).toContain('const MUTATION_P95_LIMIT_MS = 3_000;');
    expect(script).toContain(`const SESSIONS = Number(args.sessions ?? ${CDC_LOAD_TARGET.sessions});`);
    expect(doc).toContain('p95 des lectures paginées courantes < 2 s');
    expect(doc).toContain('p95 d\'une mutation simple < 3 s');
    for (const file of ['scripts/tests/load-test.mjs', 'apps/api/src/cli/seed-load.ts']) expect(existsSync(resolve(root, file)), file).toBe(true);
    const scripts = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['seed:load']).toBeDefined();
    expect(scripts['test:load']).toBe('node scripts/tests/load-test.mjs');
  });

  it('la synthèse reprend les p95 de la sortie brute de la mesure finale', () => {
    const raw = /### 6\.1[\s\S]*?```text\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
    const p95 = (label: string) => Number(new RegExp(`\\[${label}\\]\\s+(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)`).exec(raw)?.[3]);
    const read = p95('lecture');
    const mutation = p95('mutation');
    expect(read).toBeGreaterThan(0);
    expect(mutation).toBeGreaterThan(0);
    expect(raw).toContain('Verdict :');
    expect(doc).toContain(`**${thousands(Math.round(read))} ms**`);
    expect(doc).toContain(`**${thousands(Math.round(mutation))} ms**`);
    // Statut annoncé cohérent avec les seuils : un objectif dépassé n'est jamais présenté comme tenu.
    expect(doc).toContain(read < 2_000 ? 'Tenu sur la machine décrite' : 'Non tenu');
    if (mutation >= 3_000) expect(doc).toMatch(/\| p95 d'une mutation simple < 3 s \|[^\n]*\*\*Non tenu\*\*/);
  });

  it('une lecture dont le p95 atteint 2 s est déclarée non tenue dans la synthèse, même si le p95 agrégé est tenu', () => {
    const raw = /### 6\.1[\s\S]*?```text\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
    const synthesis = /## 1\. Synthèse([\s\S]*?)\n## 2\./.exec(doc)?.[1] ?? '';
    const reads = [...raw.matchAll(/^ {2}lecture · (.+?) {2,}(\d+) +([\d.]+) +([\d.]+)/gm)].map((m) => ({ name: (m[1] as string).trim(), p95: Number(m[4]) }));
    expect(reads.length).toBeGreaterThan(5);
    const readRow = synthesis.split('\n').find((line) => line.startsWith('| p95 des lectures paginées courantes < 2 s |')) ?? '';
    for (const { name, p95 } of reads.filter((r) => r.p95 >= 2_000)) {
      expect(readRow, name).toContain(`**Non tenu** pour le ${name}`);
      expect(readRow, name).toContain(`**${thousands(Math.round(p95))} ms**`);
    }
  });
});
