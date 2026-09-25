import { readFile } from 'node:fs/promises';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import type { OpenAPIObject, OperationObject, ResponseObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from './bootstrap.js';
import { IS_PUBLIC_KEY, SKIP_CSRF_KEY } from './modules/auth/auth.decorators.js';
import { OPENAPI_EXPORT_COMMAND, OPENAPI_FILE, serializeOpenApiDocument, withOpenApiApp } from './openapi-document.js';

/**
 * Contrat OpenAPI versionné (CDC 14.2 et 15.3, D-306) : docs/openapi.json doit correspondre au document
 * produit par le code, et chaque opération doit rester documentée (résumé, réponse de succès typée au code
 * HTTP réellement renvoyé, exigences de sécurité). Aucune base de données n'est nécessaire.
 */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
const MUTATIONS = new Set(['post', 'put', 'patch', 'delete']);

interface Operation {
  id: string;
  method: (typeof HTTP_METHODS)[number];
  path: string;
  operation: OperationObject;
}

function operationsOf(document: OpenAPIObject): Operation[] {
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation) operations.push({ id: `${method.toUpperCase()} ${path}`, method, path, operation });
    }
  }
  return operations;
}

interface RouteMetadata {
  /** Code HTTP de succès : @HttpCode, sinon 201 pour POST et 200 ailleurs (règle de Nest). */
  code: number;
  /** Métadonnées lues par les gardes globales SessionAuthGuard (@Public) et CsrfGuard (@SkipCsrf). */
  isPublic: boolean;
  skipCsrf: boolean;
}

/** Métadonnées de chaque méthode de contrôleur, indexées par l'operationId par défaut de @nestjs/swagger. */
function routeMetadata(app: INestApplication): Map<string, RouteMetadata> {
  const scanner = new MetadataScanner();
  const reflector = new Reflector();
  const routes = new Map<string, RouteMetadata>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const explicit = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
        routes.set(`${controller.name}_${name}`, {
          code: explicit ?? (method === RequestMethod.POST ? 201 : 200),
          isPublic: reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [handler, controller]) === true,
          skipCsrf: reflector.getAllAndOverride<boolean | undefined>(SKIP_CSRF_KEY, [handler, controller]) === true,
        });
      }
    }
  }
  return routes;
}

/** Résumé lisible de l'écart entre le fichier versionné et le document généré. */
function describeDrift(committed: string | null, expected: string): string {
  const lines = [`docs/openapi.json n'est plus à jour : ${OPENAPI_EXPORT_COMMAND}`];
  if (committed === null) {
    lines.push(`Fichier absent : ${OPENAPI_FILE}.`);
    return lines.join('\n');
  }
  let before: OpenAPIObject;
  try {
    before = JSON.parse(committed) as OpenAPIObject;
  } catch {
    lines.push('Le fichier versionné n’est pas un JSON valide.');
    return lines.join('\n');
  }
  const after = JSON.parse(expected) as OpenAPIObject;
  const index = (doc: OpenAPIObject) => new Map(operationsOf(doc).map((o) => [o.id, JSON.stringify(o.operation)]));
  const [old, current] = [index(before), index(after)];
  const added = [...current.keys()].filter((id) => !old.has(id));
  const removed = [...old.keys()].filter((id) => !current.has(id));
  const changed = [...current.keys()].filter((id) => old.has(id) && old.get(id) !== current.get(id));
  const oldSchemas = before.components?.schemas ?? {};
  const newSchemas = after.components?.schemas ?? {};
  const schemas = [...new Set([...Object.keys(oldSchemas), ...Object.keys(newSchemas)])].filter((name) => JSON.stringify(oldSchemas[name]) !== JSON.stringify(newSchemas[name]));
  const list = (label: string, items: string[]) => {
    if (items.length > 0) lines.push(`${label} (${items.length}) : ${items.slice(0, 15).join(', ')}${items.length > 15 ? ', …' : ''}`);
  };
  list('Opérations ajoutées', added);
  list('Opérations supprimées', removed);
  list('Opérations modifiées', changed);
  list('Schémas modifiés', schemas);
  if (committed.replace(/\r\n/g, '\n') === expected) lines.push('Seules les fins de ligne diffèrent (LF attendu).');
  lines.push(
    'Si l’écart persiste juste après l’export, une information du document dépend d’une métadonnée implicite (design:type) que tsc et la transformation des tests n’émettent pas à l’identique : déclarez le type explicitement (@ApiProperty({ type }), @ApiParam, @ApiQuery).',
  );
  return lines.join('\n');
}

let document: OpenAPIObject;
let routes: Map<string, RouteMetadata>;

beforeAll(async () => {
  await withOpenApiApp((app) => {
    document = buildOpenApiDocument(app);
    routes = routeMetadata(app);
  });
}, 60_000);

describe('contrat OpenAPI versionné (docs/openapi.json)', () => {
  it('le fichier versionné correspond au document généré depuis le code', async () => {
    const expected = serializeOpenApiDocument(document);
    const committed = await readFile(OPENAPI_FILE, 'utf8').catch(() => null);
    if (committed !== expected) throw new Error(describeDrift(committed, expected));
  });

  it('sérialisation déterministe : clés triées récursivement, indentation de 2 espaces, fin de ligne finale', () => {
    const sample = { paths: { '/b': { post: { summary: 'b' } }, '/a': { get: { tags: ['z', 'a'], summary: 'a' } } }, openapi: '3.0.0' } as unknown as OpenAPIObject;
    expect(serializeOpenApiDocument(sample)).toBe(
      '{\n  "openapi": "3.0.0",\n  "paths": {\n    "/a": {\n      "get": {\n        "summary": "a",\n        "tags": [\n          "z",\n          "a"\n        ]\n      }\n    },\n    "/b": {\n      "post": {\n        "summary": "b"\n      }\n    }\n  }\n}\n',
    );
    // Paramètres triés par emplacement puis nom, quel que soit l'ordre de déclaration des décorateurs.
    const withParameters = { paths: { '/x/{id}': { get: { parameters: [{ in: 'query', name: 'b' }, { in: 'path', name: 'id' }, { in: 'query', name: 'a' }] } } } } as unknown as OpenAPIObject;
    const parsed = JSON.parse(serializeOpenApiDocument(withParameters)) as { paths: Record<string, { get: { parameters: Array<{ in: string; name: string }> } }> };
    expect(parsed.paths['/x/{id}']?.get.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(['path:id', 'query:a', 'query:b']);
    const serialized = serializeOpenApiDocument(document);
    expect(serializeOpenApiDocument(JSON.parse(serialized) as OpenAPIObject)).toBe(serialized);
  });

  it('même configuration que l’API servie : titre, version, préfixe /api/v1', () => {
    expect(document.info.title).toBe('Parc Auto — API');
    expect(document.info.version).toBe('1.0.0');
    const paths = Object.keys(document.paths);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !path.startsWith('/api/v1/'))).toEqual([]);
  });

  it('chaque opération a un résumé et une réponse de succès typée', () => {
    const defects: string[] = [];
    for (const { id, operation } of operationsOf(document)) {
      if (!operation.summary?.trim()) defects.push(`${id} : summary manquant`);
      const success = Object.entries(operation.responses).filter(([code]) => /^2\d\d$/.test(code));
      if (success.length === 0) {
        defects.push(`${id} : aucune réponse 2xx documentée`);
        continue;
      }
      const typed = success.some(([code, response]) => code === '204' || Object.values((response as ResponseObject).content ?? {}).some((media) => media.schema !== undefined));
      if (!typed) defects.push(`${id} : réponse de succès sans schéma`);
    }
    expect(defects).toEqual([]);
  });

  it('chaque opération documente le code HTTP de succès réellement renvoyé', () => {
    const defects: string[] = [];
    for (const { id, operation } of operationsOf(document)) {
      const code = operation.operationId ? routes.get(operation.operationId)?.code : undefined;
      if (code === undefined) defects.push(`${id} : méthode de contrôleur introuvable (${operation.operationId ?? 'sans operationId'})`);
      else if (!(String(code) in operation.responses)) defects.push(`${id} : renvoie ${code}, documente ${Object.keys(operation.responses).join(', ')}`);
    }
    expect(defects).toEqual([]);
  });

  it('sécurité : cookie de session hors routes publiques, jeton CSRF en plus sur les mutations', () => {
    expect(document.components?.securitySchemes).toEqual({
      session: expect.objectContaining({ type: 'apiKey', in: 'cookie', name: 'pa_session' }),
      csrf: expect.objectContaining({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }),
    });
    const defects: string[] = [];
    const security = new Map<string, unknown>();
    for (const { id, method, operation } of operationsOf(document)) {
      security.set(id, operation.security);
      const route = operation.operationId ? routes.get(operation.operationId) : undefined;
      if (!route) continue; // signalé par le test des codes HTTP
      const expected = route.isPublic ? [] : [MUTATIONS.has(method) && !route.skipCsrf ? { session: [], csrf: [] } : { session: [] }];
      if (JSON.stringify(operation.security) !== JSON.stringify(expected)) defects.push(`${id} : ${JSON.stringify(operation.security)} au lieu de ${JSON.stringify(expected)}`);
    }
    expect(defects).toEqual([]);
    // Repères : routes publiques (connexion, santé), lecture authentifiée, mutation avec jeton CSRF.
    expect(security.get('POST /api/v1/auth/login')).toEqual([]);
    expect(security.get('GET /api/v1/health/live')).toEqual([]);
    expect(security.get('GET /api/v1/auth/session')).toEqual([{ session: [] }]);
    expect(security.get('POST /api/v1/vehicles')).toEqual([{ session: [], csrf: [] }]);
  });
});
