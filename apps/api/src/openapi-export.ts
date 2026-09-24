import { writeFile } from 'node:fs/promises';
import { buildOpenApiDocument, createApp } from './bootstrap.js';
import { loadEnv } from './infra/env.js';

// Exporte le contrat OpenAPI vers docs/openapi.json sans écouter sur un port.
const env = loadEnv({ ...process.env, NODE_ENV: process.env['NODE_ENV'] ?? 'development', DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgresql://export:export@localhost:5432/export' });
const app = await createApp({ env });
const document = buildOpenApiDocument(app);
const target = process.argv[2] ?? '../../docs/openapi.json';
await writeFile(target, JSON.stringify(document, null, 2));
await app.close();
process.stdout.write(`OpenAPI exporté vers ${target}\n`);
