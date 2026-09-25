import type { INestApplication } from '@nestjs/common';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import type { OpenAPIObject, SecuritySchemeObject } from '@nestjs/swagger';
import { IS_PUBLIC_KEY, SKIP_CSRF_KEY } from '../modules/auth/auth.decorators.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../modules/auth/session.service.js';

/** Schémas de sécurité OpenAPI de l'API servie (CDC 16.1) : session serveur par cookie et jeton CSRF des mutations. */
export const OPENAPI_SESSION_SCHEME = 'session';
export const OPENAPI_CSRF_SCHEME = 'csrf';

export const OPENAPI_SECURITY_SCHEMES: Record<string, SecuritySchemeObject> = {
  [OPENAPI_SESSION_SCHEME]: {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
    description: 'Session serveur révocable : cookie HttpOnly posé par POST /api/v1/auth/login. Toute route est authentifiée sauf les routes publiques (security vide).',
  },
  [OPENAPI_CSRF_SCHEME]: {
    type: 'apiKey',
    in: 'header',
    name: 'X-CSRF-Token',
    description: `Jeton CSRF à double soumission : valeur du cookie ${CSRF_COOKIE} (posé à la connexion) renvoyée dans cet en-tête sur toute mutation (POST, PUT, PATCH, DELETE) ; l'origine de la requête est également contrôlée.`,
  },
};

const MUTATING = new Set(['post', 'put', 'patch', 'delete']);
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface RouteSecurity {
  isPublic: boolean;
  skipCsrf: boolean;
}

/**
 * Exigences de sécurité par opération, lues sur les mêmes métadonnées que les gardes globales
 * (SessionAuthGuard : @Public() ; CsrfGuard : @SkipCsrf() et méthode de mutation) :
 * route publique → aucune ; lecture → cookie de session ; mutation → cookie de session et en-tête CSRF.
 */
export function applyOpenApiSecurity(app: INestApplication, document: OpenAPIObject): OpenAPIObject {
  const routes = collectRouteSecurity(app);
  document.components = { ...document.components, securitySchemes: { ...document.components?.securitySchemes, ...OPENAPI_SECURITY_SCHEMES } };
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const route = (operation.operationId ? routes.get(operation.operationId) : undefined) ?? { isPublic: false, skipCsrf: false };
      if (route.isPublic) operation.security = [];
      else if (MUTATING.has(method) && !route.skipCsrf) operation.security = [{ [OPENAPI_SESSION_SCHEME]: [], [OPENAPI_CSRF_SCHEME]: [] }];
      else operation.security = [{ [OPENAPI_SESSION_SCHEME]: [] }];
    }
  }
  return document;
}

/** Métadonnées d'accès de chaque méthode de contrôleur, indexées par l'operationId par défaut de @nestjs/swagger. */
function collectRouteSecurity(app: INestApplication): Map<string, RouteSecurity> {
  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  const routes = new Map<string, RouteSecurity>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const methodName of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;
        const targets = [handler, controller];
        routes.set(`${controller.name}_${methodName}`, {
          isPublic: reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true,
          skipCsrf: reflector.getAllAndOverride<boolean | undefined>(SKIP_CSRF_KEY, targets) === true,
        });
      }
    }
  }
  return routes;
}
