import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BreadcrumbEllipsis, BreadcrumbList } from '@/components/ui/breadcrumb';
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';

/**
 * CDC 10.1 : application en français, y compris les libellés d'accessibilité (texte réservé aux lecteurs
 * d'écran, aria-label, titres, textes d'aide des champs). Les composants shadcn/ui vendorisés arrivent avec
 * des libellés anglais (« Close », « Loading », « Go to next page »…) : ils sont traduits, et ce test
 * empêche leur retour dans tout le code de l'interface.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SCANNED = ['app', 'components'];

/** Mots anglais d'interface qui ne doivent apparaître dans aucun libellé visible ou d'accessibilité. */
const ENGLISH = /\b(close|loading|search for|go to|previous|next|more|toggle|open menu|submit|cancel|delete|edit|save|select an?|command palette|breadcrumb)\b/i;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** Libellés littéraux : attributs d'accessibilité et d'aide, texte des éléments sr-only, défauts de props. */
function literalLabels(source: string): string[] {
  const labels: string[] = [];
  for (const m of source.matchAll(/\b(?:aria-label|title|placeholder|alt|description)\s*=\s*"([^"]*)"/g)) labels.push(m[1] ?? '');
  for (const m of source.matchAll(/\b(?:aria-label|title|placeholder|alt|description)\s*=\s*\{\s*'([^']*)'\s*\}/g)) labels.push(m[1] ?? '');
  for (const m of source.matchAll(/className="[^"]*\bsr-only\b[^"]*"[^>]*>([^<{]+)</g)) labels.push(m[1] ?? '');
  for (const m of source.matchAll(/\b(?:title|description|label)\s*=\s*"([^"]+)",?\s*$/gm)) labels.push(m[1] ?? '');
  // Texte JSX littéral (« >Close< », « >Previous< ») : boutons et libellés visibles.
  for (const m of source.matchAll(/>\s*([A-Za-zÀ-ÿ][^<>{}]*?)\s*</g)) labels.push(m[1] ?? '');
  return labels.map((l) => l.trim()).filter((l) => l.length > 0);
}

describe('Libellés d’accessibilité en français (CDC 10.1)', () => {
  it('les composants ui traduits rendent des libellés français (pagination, fil d’Ariane, chargement)', () => {
    const pagination = renderToStaticMarkup(
      createElement(
        Pagination,
        null,
        createElement(
          PaginationContent,
          null,
          createElement(PaginationItem, null, createElement(PaginationPrevious, { href: '#' })),
          createElement(PaginationItem, null, createElement(PaginationEllipsis)),
          createElement(PaginationItem, null, createElement(PaginationNext, { href: '#' })),
        ),
      ),
    );
    expect(pagination).toContain('aria-label="Pagination"');
    expect(pagination).toContain('aria-label="Aller à la page précédente"');
    expect(pagination).toContain('Précédent');
    expect(pagination).toContain('aria-label="Aller à la page suivante"');
    expect(pagination).toContain('Suivant');
    expect(pagination).toContain('Autres pages');

    const breadcrumb = renderToStaticMarkup(createElement(BreadcrumbList, null, createElement(BreadcrumbEllipsis)));
    expect(breadcrumb).toContain('<span class="sr-only">Plus</span>');
    expect(renderToStaticMarkup(createElement(Spinner))).toContain('aria-label="Chargement"');
  });

  it('boîtes de dialogue et panneaux : bouton de fermeture « Fermer » (rendu hors serveur, vérifié dans la source)', () => {
    const dialog = readFileSync(join(ROOT, 'components/ui/dialog.tsx'), 'utf8');
    const sheet = readFileSync(join(ROOT, 'components/ui/sheet.tsx'), 'utf8');
    const sonner = readFileSync(join(ROOT, 'components/ui/sonner.tsx'), 'utf8');
    expect(dialog).toContain('<span className="sr-only">Fermer</span>');
    expect(dialog).toContain('<Button variant="outline">Fermer</Button>');
    expect(sheet).toContain('<span className="sr-only">Fermer</span>');
    expect(sonner).toContain('closeButtonAriaLabel: "Fermer la notification"');
    for (const source of [dialog, sheet]) expect(source).not.toMatch(/>\s*Close\s*</);
  });

  it('aucun libellé anglais dans les attributs d’accessibilité, les textes sr-only ou les libellés par défaut de l’interface', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of SCANNED) {
      for (const file of tsxFiles(join(ROOT, dir))) {
        scanned += 1;
        for (const label of literalLabels(readFileSync(file, 'utf8'))) {
          if (ENGLISH.test(label)) offenders.push(`${relative(ROOT, file)} : « ${label} »`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
