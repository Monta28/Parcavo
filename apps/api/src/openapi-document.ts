import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument, createApp } from './bootstrap.js';
import { loadEnv } from './infra/env.js';

/**
 * Contrat OpenAPI versionné (CDC 14.2 et 15.3, D-306) : docs/openapi.json, à la racine du dépôt.
 * Même chemin depuis src/ (tests) et dist/ (script compilé) : les deux dossiers sont au même niveau.
 */
export const OPENAPI_FILE = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));

/** Commande qui régénère le fichier versionné (citée par le test de dérive). */
export const OPENAPI_EXPORT_COMMAND = 'pnpm --filter @parc-auto/api openapi:export';

/**
 * Environnement de génération, indépendant du shell appelant : ni les routes ni le document ne dépendent
 * d'une variable. L'application est construite sans être initialisée (ni app.init(), ni listen) : aucune
 * connexion n'est ouverte et cette adresse de base, obligatoire pour loadEnv, n'est jamais contactée.
 */
const GENERATION_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://openapi-export@127.0.0.1:1/openapi-export-sans-connexion',
  LOG_LEVEL: 'error',
  RATE_LIMIT_ENABLED: 'false',
  TELEMETRY_SIMULATOR_ENABLED: 'false',
} as const;

/**
 * Construit l'application de l'API servie (createApp : modules, gardes, préfixe /api/v1) sans serveur HTTP
 * ni base de données, exécute fn puis la ferme.
 */
export async function withOpenApiApp<T>(fn: (app: INestApplication) => T | Promise<T>): Promise<T> {
  const app = await createApp({ env: loadEnv({ ...GENERATION_ENV }) });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

/** Document OpenAPI de l'API servie (buildOpenApiDocument : titre, version, sécurité cookie de session et jeton CSRF). */
export function generateOpenApiDocument(): Promise<OpenAPIObject> {
  return withOpenApiApp(buildOpenApiDocument);
}

/**
 * Sérialisation déterministe : clés d'objet triées récursivement, paramètres d'opération triés par
 * emplacement puis nom (leur ordre n'a pas de sens en OpenAPI : un paramètre est identifié par in + name),
 * indentation de 2 espaces, fin de ligne finale. Les autres tableaux gardent leur ordre.
 */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(canonical(document), null, 2)}\n`;
}

function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    return key === 'parameters' && items.every(isNamedParameter) ? items.sort(compareParameters) : items;
  }
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(source).sort()) sorted[k] = canonical(source[k], k);
  return sorted;
}

function isNamedParameter(value: unknown): value is { in: string; name: string } {
  const parameter = value as { in?: unknown; name?: unknown } | null;
  return typeof parameter?.in === 'string' && typeof parameter.name === 'string';
}

function compareParameters(a: { in: string; name: string }, b: { in: string; name: string }): number {
  const left = `${a.in}\u0000${a.name}`;
  const right = `${b.in}\u0000${b.name}`;
  return left < right ? -1 : left > right ? 1 : 0;
}
