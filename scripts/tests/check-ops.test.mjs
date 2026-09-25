// Auto-test des contrôles d'exploitation (CDC 14.1, 16.3, 19.2) : `node --test scripts/tests/check-ops.test.mjs`.
// Chaque cas place des fichiers dans un dossier temporaire et exécute le vrai script bash sur ce dossier
// (--root), puis sur le dépôt lui-même, qui doit passer. Les valeurs sensibles des cas refusés sont
// assemblées à l'exécution pour que ce fichier ne soit pas lui-même signalé par check-secrets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

const HERE = import.meta.dirname;
const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-ops-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(script, root) {
  const args = [join(HERE, script), ...(root ? ['--root', root] : [])];
  const result = spawnSync('bash', args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const j = (...parts) => parts.join('');
const DIGEST = 'a'.repeat(64);
const CADDY = '{\n\temail {$ACME_EMAIL}\n}\n\n{$DOMAIN} {\n\theader {\n\t\tStrict-Transport-Security "max-age=31536000"\n\t}\n\treverse_proxy api:3001\n}\n';
const COMPOSE_OK = [
  'services:',
  '  proxy:',
  `    image: caddy:2.11.4-alpine@sha256:${DIGEST}`,
  '    ports:',
  "      - '80:80'",
  "      - '443:443'",
  '  api:',
  '    build: { context: ., target: api }',
  '    image: parc-auto/api:${APP_VERSION:-local}',
  '    expose: ["3001"]',
  '  postgres:',
  `    image: postgres:16-alpine@sha256:${DIGEST}`,
  'volumes:',
  '  data:',
  '',
].join('\n');

describe('scripts/tests/check-image-tags.sh (R-14.1-06)', () => {
  it('accepte des images épinglées par version et empreinte, une étape nommée et une image construite étiquetée', () => {
    const root = tree({
      Dockerfile: `ARG NODE_IMAGE=node:24.21.0-alpine@sha256:${DIGEST}\nFROM \${NODE_IMAGE} AS base\nFROM base AS build\nFROM --platform=linux/amd64 caddy:2.11.4-alpine@sha256:${DIGEST}\n`,
      'docker-compose.prod.yml': COMPOSE_OK,
    });
    const { code, out } = run('check-image-tags.sh', root);
    assert.equal(code, 0, out);
    assert.match(out, /aucune image latest ni non épinglée/);
  });

  it('refuse latest, une étiquette sans empreinte, une image sans étiquette et un argument sans valeur par défaut', () => {
    const root = tree({
      Dockerfile: 'ARG BASE\nFROM node:latest AS a\nFROM node:24-alpine AS b\nFROM ${BASE}\n',
      'docker-compose.yml': 'services:\n  mail:\n    image: axllent/mailpit:v1.28\n  db:\n    image: postgres\n  web:\n    build: .\n    image: parc-auto/web:latest\n  cache:\n    build: .\n    image: parc-auto/cache\n',
    });
    const { code, out } = run('check-image-tags.sh', root);
    assert.equal(code, 1, out);
    assert.match(out, /Dockerfile:2 — image « node:latest » : étiquette latest interdite/);
    assert.match(out, /Dockerfile:3 — image « node:24-alpine » non épinglée/);
    assert.match(out, /Dockerfile:4 — FROM \$\{BASE\} : argument sans valeur par défaut/);
    assert.match(out, /docker-compose.yml:3 — service mail : image « axllent\/mailpit:v1.28 » non épinglée/);
    assert.match(out, /docker-compose.yml:5 — service db : image « postgres » non épinglée/);
    assert.match(out, /service web : image « parc-auto\/web:latest » en latest/);
    assert.match(out, /service cache : image construite « parc-auto\/cache » sans étiquette explicite/);
  });

  it('le dépôt respecte la règle', () => {
    const { code, out } = run('check-image-tags.sh');
    assert.equal(code, 0, out);
  });
});

describe('scripts/tests/check-exposed-ports.sh (R-16.3-04)', () => {
  it('accepte un proxy Caddy qui publie 80 et 443, en HTTPS automatique avec HSTS', () => {
    const root = tree({ 'docker-compose.prod.yml': COMPOSE_OK, 'deploy/Caddyfile': CADDY });
    const { code, out } = run('check-exposed-ports.sh', root);
    assert.equal(code, 0, out);
    assert.match(out, /seul le reverse proxy publie 80 et 443/);
  });

  it('refuse une base ou une API publiées, un mode réseau hôte, un port supplémentaire du proxy et un site en HTTP clair', () => {
    const compose = COMPOSE_OK.replace("      - '443:443'", "      - '443:443'\n      - '2019:2019'")
      .replace('    expose: ["3001"]', "    ports: ['3001:3001']")
      .replace(`  postgres:\n    image: postgres:16-alpine@sha256:${DIGEST}`, `  postgres:\n    image: postgres:16-alpine@sha256:${DIGEST}\n    ports:\n      - "127.0.0.1:5432:5432"\n  worker:\n    image: parc-auto/worker:1\n    network_mode: host`);
    const root = tree({ 'docker-compose.prod.yml': compose, 'deploy/Caddyfile': 'http://parc.example.tn {\n\treverse_proxy web:3000\n}\n' });
    const { code, out } = run('check-exposed-ports.sh', root);
    assert.equal(code, 1, out);
    assert.match(out, /proxy proxy : port « 2019:2019 » inattendu/);
    assert.match(out, /service api : publie des ports sur l'hôte/);
    assert.match(out, /service postgres : publie des ports sur l'hôte/);
    assert.match(out, /service worker : network_mode host interdit/);
    assert.match(out, /site servi en HTTP clair/);
    assert.match(out, /en-tête Strict-Transport-Security absent/);
  });

  it('le dépôt respecte la règle', () => {
    const { code, out } = run('check-exposed-ports.sh');
    assert.equal(code, 0, out);
  });
});

describe('scripts/tests/check-env-example.sh (R-16.3-03)', () => {
  const sources = {
    'apps/api/src/infra/env.ts': "read('DATABASE_URL'); readInt('PORT', 3001); readBool('RATE_LIMIT_ENABLED', true); read('SMTP_PASSWORD');\n",
    'apps/web/lib/api-server.ts': 'const base = process.env.API_INTERNAL_URL;\n',
    'packages/db/src/cli/create-admin.ts': "const pwd = process.env['ADMIN_PASSWORD'];\n",
    'docker-compose.prod.yml': 'services:\n  proxy:\n    environment:\n      DOMAIN: ${DOMAIN:?DOMAIN requis}\n',
    'deploy/Caddyfile': '{$DOMAIN} {\n\temail {$ACME_EMAIL}\n}\n',
    'scripts/ops/backup.sh': ': "${BACKUP_ENCRYPTION_KEY:?obligatoire}"\nDIR="${BACKUP_DIR:-./backups}"\nlocal_only="$work"\n',
  };

  it('accepte un modèle qui documente chaque variable (active ou en commentaire), secrets vides', () => {
    const root = tree({
      ...sources,
      '.env.example': j('DATABASE_URL=postgresql://parc_auto:parc_auto_dev@localhost:5432/parc_auto\nPORT=3001\nRATE_LIMIT_ENABLED=true\nSMTP_', 'PASSWORD=\nAPI_INTERNAL_URL=http://localhost:3001\n# ADMIN_', 'PASSWORD=\nDOMAIN=\nACME_EMAIL=\nBACKUP_ENCRYPTION_', 'KEY=\nBACKUP_DIR=./backups\n'),
    });
    const { code, out } = run('check-env-example.sh', root);
    assert.equal(code, 0, out);
    assert.match(out, /10 variable\(s\) lue\(s\) par l'application et l'exploitation, toutes documentées/);
  });

  it('refuse une variable lue mais non documentée et une valeur sensible renseignée', () => {
    const root = tree({
      ...sources,
      '.env.example': j('DATABASE_URL=\nPORT=3001\nSMTP_', 'PASSWORD=Relais-2026\nAPI_INTERNAL_URL=\n# ADMIN_', 'PASSWORD=\nDOMAIN=\nBACKUP_ENCRYPTION_', 'KEY=\nBACKUP_DIR=\n'),
    });
    const { code, out } = run('check-env-example.sh', root);
    assert.equal(code, 1, out);
    assert.match(out, /variable « RATE_LIMIT_ENABLED » lue/);
    assert.match(out, /variable « ACME_EMAIL » lue/);
    assert.match(out, /la variable sensible « SMTP_PASSWORD » a une valeur/);
    assert.doesNotMatch(out, /Relais-2026/);
  });

  it('le dépôt respecte la règle', () => {
    const { code, out } = run('check-env-example.sh');
    assert.equal(code, 0, out);
  });
});

describe('scripts/tests/check-production-claim.sh (R-19.3-07)', () => {
  const PR = j('production', ' ready');
  it('admet l’énoncé de l’interdiction, refuse une annonce en anglais ou en français', () => {
    const ok = tree({ 'docs/cdc.md': `Ne jamais annoncer « ${PR} » sur la seule base d’un build.\nPas de « ${PR} » sur un build.\n` });
    const accepted = run('check-production-claim.sh', ok);
    assert.equal(accepted.code, 0, accepted.out);

    const bad = tree({ 'docs/rapport.md': `Recette terminée : la V1 est ${PR}.\n`, 'README.md': j('Application prête', ' pour la production.\n') });
    const { code, out } = run('check-production-claim.sh', bad);
    assert.equal(code, 1, out);
    assert.match(out, /docs\/rapport.md:1 — annonce/);
    assert.match(out, /README.md:1 — annonce/);
  });

  it('le dépôt respecte la règle', () => {
    const { code, out } = run('check-production-claim.sh');
    assert.equal(code, 0, out);
  });
});
