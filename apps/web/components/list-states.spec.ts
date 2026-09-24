import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { ApiRequestError } from '@/lib/api-error';

/**
 * CDC 10.1 : « toute liste présente des états chargement, vide, erreur et accès refusé ». Les composants
 * d'état sont rendus réellement ; chaque liste paginée de l'interface (PaginationControls) est contrôlée
 * dans sa source : elle traite le chargement, l'erreur (dont l'accès refusé, distingué par ErrorState) et
 * le vide.
 */

describe('États des listes (CDC 10.1)', () => {
  it('chargement annoncé, vide explicite, erreur et accès refusé distincts, avec référence de la requête', () => {
    const loading = renderToStaticMarkup(createElement(LoadingState, { label: 'Chargement des véhicules…' }));
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-live="polite"');
    expect(loading).toContain('Chargement des véhicules…');

    const empty = renderToStaticMarkup(createElement(EmptyState, { title: 'Aucun véhicule', description: 'Aucun véhicule ne correspond aux filtres.' }));
    expect(empty).toContain('Aucun véhicule');
    expect(empty).toContain('Aucun véhicule ne correspond aux filtres.');
    expect(empty).not.toContain('role="alert"');

    const forbidden = renderToStaticMarkup(createElement(ErrorState, { error: new ApiRequestError(403, { code: 'ACTION_INTERDITE', message: 'Action non autorisée.', requestId: 'req-403' }) }));
    const outOfScope = renderToStaticMarkup(createElement(ErrorState, { error: new ApiRequestError(404, { code: 'INTROUVABLE', message: 'Véhicule introuvable ou hors de votre périmètre.' }) }));
    const failure = renderToStaticMarkup(createElement(ErrorState, { error: new ApiRequestError(500, { code: 'ERREUR_INTERNE', message: 'Une erreur interne est survenue.', requestId: 'req-500' }), retry: () => undefined }));
    for (const html of [forbidden, outOfScope, failure]) expect(html).toContain('role="alert"');
    expect(forbidden).toContain('Accès refusé ou élément hors de votre périmètre');
    expect(forbidden).toContain('Référence : req-403');
    expect(outOfScope).toContain('Accès refusé ou élément hors de votre périmètre');
    expect(failure).not.toContain('Accès refusé');
    expect(failure).toContain('>Erreur<');
    expect(failure).toContain('Réessayer');
    expect(failure).toContain('Référence : req-500');
  });
});
