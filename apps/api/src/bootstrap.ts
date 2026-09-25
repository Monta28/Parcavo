import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { applyOpenApiSecurity } from './common/openapi-security.js';
import { RedactingConsoleLogger } from './common/redacting-logger.js';
import { requestIdMiddleware } from './common/request-id.middleware.js';
import { APP_ENV, type AppEnv } from './infra/env.js';
import { WEBHOOK_MAX_BODY_BYTES } from './modules/telemetry/webhook/telemetry-webhook-format.js';
import { webhookRawBodyMiddleware } from './modules/telemetry/webhook/webhook-raw-body.middleware.js';

export const API_PREFIX = 'api/v1';

/** Crée l'application HTTP complète (utilisée par main.ts et par les tests d'intégration). */
export async function createApp(options: AppModuleOptions = {}): Promise<NestExpressApplication> {
  // Journal avec masquage des secrets et jetons (D-304, T44) : motifs sensibles et secrets fournisseur en cours d'usage.
  const logger = new RedactingConsoleLogger({ logLevels: options.env?.nodeEnv === 'test' ? ['error', 'warn'] : ['log', 'error', 'warn'] });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), { bufferLogs: false, logger });
  const env = app.get<AppEnv>(APP_ENV);
  app.setGlobalPrefix(API_PREFIX);
  app.set('trust proxy', env.trustProxy ? 1 : false);
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  // Lots webhook fournisseurs (D-298) : corps brut borné, lu avant les analyseurs JSON (signature HMAC des octets reçus).
  app.use(`/${API_PREFIX}/telemetry/webhooks`, webhookRawBodyMiddleware(WEBHOOK_MAX_BODY_BYTES));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } }));
  app.use(cookieParser());
  app.enableShutdownHooks();
  return app;
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Parc Auto — API')
    .setDescription('API REST de gestion de parc automobile multi-sociétés (CDC v1.1). Authentification par session (cookie HttpOnly) et jeton CSRF (en-tête X-CSRF-Token) sur les mutations.')
    .setVersion('1.0.0')
    .build();
  // Schémas « session » (cookie pa_session) et « csrf » (en-tête X-CSRF-Token), exigés opération par opération.
  return applyOpenApiSecurity(app, SwaggerModule.createDocument(app, config));
}

export function mountOpenApi(app: INestApplication): void {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs.json', useGlobalPrefix: false });
}
