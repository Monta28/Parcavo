import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CDC 14.1 : socle (Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui ; NestJS ; PostgreSQL et
 * Prisma ; Playwright) et adaptations documentées dans docs/ARCHITECTURE.md. Le test confronte le document
 * au dépôt : un écart non documenté, ou un document cité mais absent, le fait échouer.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
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
});
