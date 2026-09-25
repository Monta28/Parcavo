import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CDC 14.1 : socle (Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui ; NestJS ; PostgreSQL et
 * Prisma ; Playwright) et adaptations documentées dans docs/ARCHITECTURE.md. Le test confronte le document
 * au dépôt : un écart non documenté, ou un document cité mais absent, le fait échouer.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ARCHITECTURE = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const deps = (path: string) => ({ ...json(path).dependencies, ...json(path).devDependencies });

describe('Socle et adaptations (CDC 14.1, docs/ARCHITECTURE.md)', () => {
  it('frontend Next.js App Router en TypeScript strict, Tailwind CSS et composants shadcn/ui vendorisés', () => {
    const web = deps('apps/web/package.json');
    expect(web['next']).toMatch(/^16\./);
    expect(web['typescript']).toBeDefined();
    expect(web['tailwindcss']).toMatch(/^4\./);
    expect(web['@radix-ui/react-dialog']).toBeDefined();
    expect(web['class-variance-authority']).toBeDefined();
    expect(existsSync(join(ROOT, 'apps/web/app/layout.tsx'))).toBe(true);
    expect(existsSync(join(ROOT, 'apps/web/pages'))).toBe(false);
    expect(readFileSync(join(ROOT, 'apps/web/tsconfig.json'), 'utf8')).toMatch(/"strict":\s*true/);
    expect(readFileSync(join(ROOT, 'apps/web/app/globals.css'), 'utf8')).toMatch(/@import ['"]tailwindcss['"]/);
    for (const component of ['button', 'dialog', 'table', 'select', 'sheet']) expect(existsSync(join(ROOT, `apps/web/components/ui/${component}.tsx`)), component).toBe(true);
    expect(deps('apps/api/package.json')['@nestjs/core']).toBeDefined();
    expect(deps('packages/db/package.json')['prisma']).toBeDefined();
    expect(deps('tests/e2e/package.json')['@playwright/test']).toBeDefined();
  });

  it('chaque adaptation du tableau « Adaptations au socle proposé » correspond au dépôt', () => {
    expect(ARCHITECTURE).toContain('## Adaptations au socle proposé (CDC 14.1)');
    // Le tableau documente chaque écart vérifié ci-dessous (élément proposé → réalisation) : retirer une ligne échoue.
    const start = ARCHITECTURE.indexOf('## Adaptations au socle proposé (CDC 14.1)');
    const section = ARCHITECTURE.slice(start, ARCHITECTURE.indexOf('\n## ', start + 5));
    const rows = new Map([...section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \|$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']));
    expect(rows.get('`prisma/migrations`')).toContain('`packages/db/prisma/migrations`');
    expect(rows.get('`apps/telemetry-rpa`')).toBe('Absent');
    expect(rows.get('Composants shadcn/ui')).toMatch(/`apps\/web\/components\/ui`.*sans `components\.json`/);
    expect(rows.get('Configuration Tailwind')).toMatch(/Tailwind CSS 4.*sans `tailwind\.config\.ts`/);
    expect(rows.get('Jeu de démonstration')).toContain('`apps/api/src/cli/seed-demo.ts`');
    expect(rows.get('Dockerfiles par application')).toMatch(/`Dockerfile` unique.*`deploy\/Caddyfile`/);
    expect(rows.get('Redis')).toBe('Non utilisé');
    // Migrations dans packages/db, pas à la racine.
    const migrations = readdirSync(join(ROOT, 'packages/db/prisma/migrations')).filter((d) => statSync(join(ROOT, 'packages/db/prisma/migrations', d)).isDirectory());
    expect(migrations.length).toBeGreaterThan(0);
    expect(existsSync(join(ROOT, 'prisma/migrations'))).toBe(false);
    // Canal RPA non retenu.
    expect(existsSync(join(ROOT, 'apps/telemetry-rpa'))).toBe(false);
    // shadcn/ui vendorisé sans components.json, Tailwind 4 sans tailwind.config.
    expect(existsSync(join(ROOT, 'apps/web/components.json'))).toBe(false);
    expect(readdirSync(join(ROOT, 'apps/web')).some((f) => f.startsWith('tailwind.config'))).toBe(false);
    // Jeu de démonstration, image multi-cibles et reverse proxy.
    expect(existsSync(join(ROOT, 'apps/api/src/cli/seed-demo.ts'))).toBe(true);
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    for (const target of ['api', 'worker', 'migrate', 'web']) expect(dockerfile, target).toMatch(new RegExp(`^FROM \\S+ AS ${target}$`, 'm'));
    expect(existsSync(join(ROOT, 'deploy/Caddyfile'))).toBe(true);
    // Pas de Redis : jobs et outbox en PostgreSQL.
    for (const pkg of ['apps/api', 'apps/worker', 'apps/web', 'packages/db']) {
      expect(Object.keys(deps(`${pkg}/package.json`)).filter((d) => /redis|bullmq/i.test(d)), pkg).toEqual([]);
    }
  });

  it('les documents cités dans l’arborescence de docs/ existent', () => {
    const tree = ARCHITECTURE.slice(ARCHITECTURE.indexOf('└── docs/'), ARCHITECTURE.indexOf('```', ARCHITECTURE.indexOf('└── docs/')));
    const cited = [...tree.matchAll(/([\w.-]+\.(?:md|json))/g)].map((m) => m[1] ?? '');
    expect(cited.length).toBeGreaterThan(8);
    expect(cited.filter((name) => !existsSync(join(ROOT, 'docs', name)))).toEqual([]);
  });
});
