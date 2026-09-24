import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ErrorPage from '@/app/error';
import GlobalError from '@/app/global-error';
import NotFound from '@/app/not-found';

/**
 * CDC 10.1 : « tous les libellés, messages et statuts de l'interface sont en français ». Sans fichiers
 * not-found, error et global-error, Next.js affiche ses écrans anglais (« This page could not be found. »,
 * « Application error: a client-side exception has occurred »). Rendu réel des écrans de remplacement.
 */

const ROOT = resolve(import.meta.dirname, '..');
const ENGLISH = /could not be found|application error|something went wrong|try again|go back|internal server error/i;
const noop = () => undefined;

describe('Écrans d’erreur de l’application en français (CDC 10.1)', () => {
  it('les écrans 404, erreur de page et erreur racine remplacent ceux de Next.js', () => {
    for (const file of ['app/not-found.tsx', 'app/error.tsx', 'app/global-error.tsx']) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  it('page introuvable : titre, explication et retour à l’accueil en français', () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain('Page introuvable');
    expect(html).toContain('Erreur 404');
    expect(html).toContain('Retour à l’accueil');
    expect(html).toContain('href="/"');
    expect(html).not.toMatch(ENGLISH);
  });

  it('erreur inattendue : message français, référence du serveur, « Réessayer », jamais le texte technique de l’erreur', () => {
    const technical = Object.assign(new Error('TypeError: Failed to fetch'), { digest: 'DIGEST-1234' });
    const page = renderToStaticMarkup(createElement(ErrorPage, { error: technical, retry: noop }));
    expect(page).toContain('role="alert"');
    expect(page).toContain('Une erreur est survenue');
    expect(page).toContain('Référence : DIGEST-1234');
    expect(page).toContain('Réessayer');
    expect(page).not.toContain('Failed to fetch');
    expect(page).not.toMatch(ENGLISH);

    const root = renderToStaticMarkup(createElement(GlobalError, { error: new Error('boom'), retry: noop }));
    expect(root).toContain('<html lang="fr"');
    expect(root).toContain('Une erreur est survenue');
    expect(root).not.toContain('Référence');
    expect(root).not.toContain('boom');
    expect(root).not.toMatch(ENGLISH);
  });
});
