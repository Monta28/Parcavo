/**
 * Export du contrat OpenAPI versionné (CDC 14.2 et 15.3, D-306).
 *
 *   pnpm --filter @parc-auto/api openapi:export
 *
 * compile l'API puis écrit docs/openapi.json à partir de la configuration de l'API servie (titre, version,
 * préfixe /api/v1, sécurité cookie de session et jeton CSRF), sans démarrer de serveur HTTP ni ouvrir de
 * connexion à la base. Sortie déterministe : clés triées, indentation de 2 espaces, fin de ligne finale.
 * Argument facultatif : autre chemin de sortie. Le test src/openapi-drift.spec.ts échoue tant que le
 * fichier versionné diffère du document produit par le code.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateOpenApiDocument, OPENAPI_FILE, serializeOpenApiDocument } from '../openapi-document.js';

const target = process.argv[2] ? resolve(process.argv[2]) : OPENAPI_FILE;
const document = await generateOpenApiDocument();
await writeFile(target, serializeOpenApiDocument(document), 'utf8');
const operations = Object.values(document.paths).reduce((count, item) => count + ['get', 'put', 'post', 'delete', 'patch'].filter((m) => m in item).length, 0);
process.stdout.write(`Contrat OpenAPI écrit dans ${target} : ${Object.keys(document.paths).length} chemins, ${operations} opérations.\n`);
