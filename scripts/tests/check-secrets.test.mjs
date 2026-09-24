// Auto-test du contrôle des secrets (CDC 16.1) : `node --test scripts/tests/`.
// Chaque cas crée un petit dépôt git temporaire, y place des fichiers et exécute le vrai script.
// Les valeurs sensibles sont assemblées à l'exécution pour que ce fichier ne soit pas lui-même signalé.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPT = join(import.meta.dirname, 'check-secrets.mjs');
const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-secrets-'));
  created.push(root);
  execFileSync('git', ['init', '-q', root]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(root, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const j = (...parts) => parts.join('');
const PEM = j('-----BEGIN', ' RSA PRIVATE', ' KEY-----\n', 'MIIEowIBAAKCAQEA1c7x', 'Q'.repeat(60), '\n-----END', ' RSA PRIVATE', ' KEY-----\n');
const KEY_B64 = Buffer.alloc(32, 42).toString('base64');

describe('scripts/tests/check-secrets.mjs', () => {
  it('accepte les valeurs de développement documentées, les interpolations et les exemples vides', () => {
    const root = repo({
      'docker-compose.yml': j('services:\n  postgres:\n    environment:\n      POSTGRES_', 'PASSWORD: ${POSTGRES_', 'PASSWORD:-parc_auto_dev}\n  postgres-test:\n    environment:\n      POSTGRES_', 'PASSWORD: parc_auto_test\n'),
      '.env.example': j('DATABASE_', 'URL=postgresql://parc_auto:parc_auto_dev@localhost:5432/parc_auto\nSECRETS_ENCRYPTION_', 'KEY=\nSMTP_', 'PASSWORD=\n'),
      'deploy/compose.prod.yml': j('  SECRETS_ENCRYPTION_', 'KEY: ${SECRETS_ENCRYPTION_', 'KEY:?requis}\n'),
      'app/test/factories.ts': j("export const DEFAULT_", "PASSWORD = 'MotDePasse-Test-123';\n"),
      'app/src/redaction.spec.ts': j("const url = 'https://user:mdp@gps.", "example.com/api';\n"),
      'docs/guide.md': j('Clé SFTP : `identifiant:` suivi d’une clé privée PEM, jamais versionnée.\n', 'TEST_DATABASE_', 'URL=… npx vitest run\n'),
    });
    const { code, out } = run(root);
    assert.equal(code, 0, out);
    assert.match(out, /aucun secret trouvé/);
    assert.match(out, /bundle client : non construit/);
  });

  it('refuse une clé privée, une clé de chiffrement littérale, un mot de passe de production et des identifiants dans une URL', () => {
    const root = repo({
      'deploy/id_rsa': PEM,
      'config/.env.production': j('SMTP_', 'PASSWORD=Relais-Prod-2026\nSECRETS_ENCRYPTION_', 'KEY=', KEY_B64, '\n'),
      'deploy/run.sh': j('SMTP_', 'PASSWORD="Relais Prod 2026" node dist/main.js\n'),
      'app/src/env.ts': j("export const env = { SECRETS_ENCRYPTION_", "KEY: '", KEY_B64, "' };\n"),
      'app/src/db.ts': j("const url = 'postgresql://parc_auto:", 'Pr0d-S3cret', "@db.parc-auto.tn:5432/parc_auto';\n"),
      'app/test/token.spec.ts': j("const jeton = 'gh", 'p_', 'A'.repeat(36), "';\n"),
    });
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /deploy\/id_rsa:1 — clé privée PEM/);
    assert.match(out, /config\/\.env\.production:1 — valeur littérale de SMTP_PASSWORD/);
    assert.match(out, /config\/\.env\.production:2 — valeur littérale de SECRETS_ENCRYPTION_KEY/);
    assert.match(out, /deploy\/run\.sh:1 — valeur littérale de SMTP_PASSWORD/);
    assert.match(out, /app\/src\/env\.ts:1 — chaîne littérale affectée à SECRETS_ENCRYPTION_KEY/);
    assert.match(out, /app\/src\/db\.ts:1 — identifiants intégrés à une URL postgresql:\/\/ vers db\.parc-auto\.tn:5432/);
    assert.match(out, /app\/test\/token\.spec\.ts:1 — jeton GitHub/);
    // Les valeurs sont masquées dans la sortie.
    assert.doesNotMatch(out, /Relais-Prod-2026|Pr0d-S3cret/);
  });

  it('bundle client : refuse un nom de configuration serveur, une chaîne de connexion et la valeur d’une variable sensible ; exige le bundle après build', () => {
    const clean = repo({ 'apps/web/.next/static/chunks/app.js': 'console.log("Bonjour");\n' });
    assert.equal(run(clean, ['--require-bundle']).code, 0);

    const leaked = repo({
      'apps/web/.next/static/chunks/a.js': j('var u=process.env.DATABASE_', 'URL;'),
      'apps/web/.next/static/chunks/b.js': j('fetch("postgresql://', 'x:y@db/z")'),
      'apps/web/.next/static/chunks/c.js': j('var k="', 'relais-smtp-9f8e7d', '";'),
    });
    const { code, out } = run(leaked, ['--bundle-only'], { SMTP_PASSWORD: j('relais-smtp-', '9f8e7d') });
    assert.equal(code, 1, out);
    assert.match(out, /chunks\/a\.js:1 — nom de configuration serveur DATABASE_URL dans le bundle client/);
    assert.match(out, /chunks\/b\.js:1 — chaîne de connexion PostgreSQL dans le bundle client/);
    assert.match(out, /chunks\/c\.js:1 — valeur de la variable SMTP_PASSWORD dans le bundle client/);

    const missing = run(repo({ 'README.md': 'Projet\n' }), ['--require-bundle']);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /bundle client absent/);
  });
});
