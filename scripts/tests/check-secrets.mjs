#!/usr/bin/env node
/**
 * Contrôle automatisé des secrets (CDC 16.1 : « aucun secret en dur, dans le dépôt, dans les journaux ou
 * exposé au bundle frontend »).
 *
 *   node scripts/tests/check-secrets.mjs                  dépôt + bundle client s'il a été construit
 *   node scripts/tests/check-secrets.mjs --require-bundle dépôt + bundle client obligatoire (après build)
 *   node scripts/tests/check-secrets.mjs --bundle-only --require-bundle
 *   options de test : --root <dossier> (dépôt git à contrôler), --bundle-dir <dossier>
 *
 * 1. Dépôt : tous les fichiers suivis par git et ceux qui le seraient au prochain ajout (non ignorés).
 *    Refusés : clé privée PEM avec son contenu, jetons reconnaissables (AWS, GitHub, Slack, Google, Stripe,
 *    Anthropic, OpenAI, JWT signé), identifiants intégrés à une URL (scheme://utilisateur:motdepasse@hôte)
 *    hors hôte local ou domaine de documentation (example.*, *.test, *.local), et valeur littérale d'une
 *    variable sensible (SECRETS_ENCRYPTION_KEY, SECRETS_ENCRYPTION_PREVIOUS_KEYS, SMTP_PASSWORD,
 *    POSTGRES_PASSWORD, DATABASE_URL, *_PASSWORD, *_SECRET, *_TOKEN, *_API_KEY) dans un fichier de
 *    configuration ou une chaîne de code, sauf vide, interpolation (${…}) ou valeur de développement.
 *    Valeurs de développement admises, exclusivement locales (docker-compose.yml, .env.example, tests) :
 *    les mots de passe PostgreSQL « parc_auto_dev » et « parc_auto_test », et les mots de passe des comptes
 *    fictifs créés par les tests (variables …_PASSWORD dans un fichier de test) ; jamais une clé ni un jeton.
 * 2. Bundle client (apps/web/.next/static, servi au navigateur) : aucun nom de variable de configuration
 *    serveur sensible, aucune chaîne de connexion PostgreSQL, aucune clé privée ni jeton reconnaissable, et
 *    aucune valeur d'une variable sensible présente dans l'environnement du contrôle (build de production).
 *
 * Sortie : liste « fichier:ligne — règle » avec la valeur masquée ; code 1 dès qu'un secret est trouvé.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROOT = resolve(option('--root') ?? join(import.meta.dirname, '..', '..'));
const BUNDLE_DIR = resolve(option('--bundle-dir') ?? join(ROOT, 'apps/web/.next/static'));
const REQUIRE_BUNDLE = args.includes('--require-bundle');
const BUNDLE_ONLY = args.includes('--bundle-only');

/** Mots de passe de développement documentés comme exclusivement locaux (docker-compose.yml, tests). */
const DEV_VALUES = new Set(['parc_auto_dev', 'parc_auto_test']);
/** Hôtes et domaines sans secret réel : poste local, conteneurs de développement, domaines de documentation (RFC 2606). */
const SAFE_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|postgres|postgres-test|mailpit|([a-z0-9-]+\.)*(example(\.[a-z]+)?|test|local|invalid))(:\d+)?$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Motifs construits par concaténation pour que ce fichier ne se signale pas lui-même.
const PEM_HEADER = '-----' + 'BEGIN ([A-Z0-9]+ )*PRIVATE KEY' + '-----';
const TOKEN_RULES = [
  { rule: 'clé privée PEM', re: new RegExp(PEM_HEADER + '\\s*[\\r\\n]+\\s*[A-Za-z0-9+/=]{40,}') },
  { rule: 'clé d’accès AWS', re: new RegExp('\\b(AKIA|ASIA)[0-9A-Z]{16}\\b') },
  { rule: 'jeton GitHub', re: new RegExp('\\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\\b') },
  { rule: 'jeton Slack', re: new RegExp('\\bxox[abprs]-[A-Za-z0-9-]{20,}') },
  { rule: 'clé d’API Google', re: new RegExp('\\bAIza[0-9A-Za-z_-]{35}\\b') },
  { rule: 'clé secrète Stripe', re: new RegExp('\\b[sr]k_live_[0-9A-Za-z]{20,}') },
  { rule: 'clé d’API Anthropic ou OpenAI', re: new RegExp('\\bsk-(ant-[A-Za-z0-9_-]{30,}|proj-[A-Za-z0-9_-]{30,}|[A-Za-z0-9]{40,})\\b') },
  // JWT signé : signature d'au moins 43 caractères (HS256) ; les exemples tronqués des tests ne sont pas visés.
  { rule: 'jeton JWT signé', re: new RegExp('\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{43,}') },
];

/** Variables dont une valeur littérale ne doit jamais figurer dans le dépôt. */
const SENSITIVE_VAR = '(SECRETS_ENCRYPTION_KEY|SECRETS_ENCRYPTION_PREVIOUS_KEYS|SMTP_PASSWORD|POSTGRES_PASSWORD|DATABASE_URL|TEST_DATABASE_URL|[A-Z][A-Z0-9_]*_(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY))';
/** Fichier de configuration : affectation « NOM=valeur » ou « NOM: valeur ». */
const CONFIG_ASSIGN = new RegExp(`^\\s*(?:export\\s+|-\\s+)?${SENSITIVE_VAR}\\s*[=:]\\s*(.*)$`);
/** Code : chaîne littérale affectée à une variable sensible (« NOM: 'valeur' », NOM = "valeur"). */
const CODE_ASSIGN = new RegExp(`\\b${SENSITIVE_VAR}['"]?\\s*[=:]\\s*(['"\`])([^'"\`]*)\\3`, 'g');
const CONFIG_FILE = /(^|\/)(\.env(\.[\w-]+)?|Dockerfile[\w.-]*|Caddyfile|[^/]*\.(ya?ml|env|sh|conf|ini|toml|properties|md))$/;
const CODE_FILE = /\.(m?[jt]sx?|cjs|json)$/;
// Hôte réel : nom qualifié ou adresse (au moins un point) ; « hôte », « host » des commentaires ne sont pas visés.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/:@'"`]+):([^\s/@'"`]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+(?::\d+)?|localhost(?::\d+)?|\$\{[^}]+\}[^\s/?#'"`]*)/gi;
/** Fichiers de test : leurs mots de passe de comptes fictifs (…_PASSWORD) ne servent qu'aux bases de test. */
const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$/;

/** Vrai si la valeur n'est pas un secret : vide, interpolation, placeholder ou valeur de développement. */
function harmlessValue(raw) {
  const trimmed = raw.trim();
  // Valeur entre guillemets : son contenu ; sinon le premier mot (« NOM=valeur commande … », « NOM: valeur # note »).
  const quoted = /^(['"])(.*?)\1/.exec(trimmed);
  const value = quoted ? quoted[2].trim() : (trimmed.split(/\s+/)[0] ?? '');
  if (value === '' || value.startsWith('$') || value.includes('${') || /^<[^>]*>$/.test(value) || value === '…' || value === '...') return true;
  if (DEV_VALUES.has(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return urlCredentialsHarmless(value);
  return false;
}

function urlCredentialsHarmless(url) {
  URL_CREDENTIALS.lastIndex = 0;
  const m = URL_CREDENTIALS.exec(url);
  if (!m) return true; // URL sans identifiants intégrés
  const [, , , password, host] = m;
  return password.startsWith('$') || SAFE_HOST.test(host) || DEV_VALUES.has(password);
}

function mask(value) {
  const v = value.trim();
  return v.length <= 4 ? '***' : `${v.slice(0, 4)}***`;
}

function listRepositoryFiles() {
  const git = (extra) => execFileSync('git', ['-C', ROOT, 'ls-files', '-z', ...extra], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = new Set([...git([]).split('\0'), ...git(['--others', '--exclude-standard']).split('\0')].filter(Boolean));
  return [...files].sort();
}

function readText(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null; // supprimé du disque mais encore suivi
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  const buffer = readFileSync(path);
  if (buffer.includes(0)) return null; // binaire (images, PDF, archives)
  return buffer.toString('utf8');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scanRepository(findings) {
  const files = listRepositoryFiles();
  let scanned = 0;
  for (const file of files) {
    const text = readText(join(ROOT, file));
    if (text === null) continue;
    scanned += 1;
    for (const { rule, re } of TOKEN_RULES) {
      const m = re.exec(text);
      if (m) findings.push({ where: `${file}:${lineOf(text, m.index)}`, rule, value: m[0] });
    }
    for (const m of text.matchAll(URL_CREDENTIALS)) {
      const [, scheme, , password, host] = m;
      if (password.startsWith('$') || SAFE_HOST.test(host) || DEV_VALUES.has(password)) continue;
      findings.push({ where: `${file}:${lineOf(text, m.index)}`, rule: `identifiants intégrés à une URL ${scheme}:// vers ${host}`, value: password });
    }
    if (CONFIG_FILE.test(file)) {
      text.split('\n').forEach((line, i) => {
        const m = CONFIG_ASSIGN.exec(line);
        if (m && !harmlessValue(m[3])) findings.push({ where: `${file}:${i + 1}`, rule: `valeur littérale de ${m[1]}`, value: m[3] });
      });
    }
    if (CODE_FILE.test(file)) {
      for (const m of text.matchAll(CODE_ASSIGN)) {
        if (TEST_FILE.test(file) && /_PASSWORD$/.test(m[1])) continue;
        if (!harmlessValue(m[4])) findings.push({ where: `${file}:${lineOf(text, m.index)}`, rule: `chaîne littérale affectée à ${m[1]}`, value: m[4] });
      }
    }
  }
  return scanned;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Noms de configuration serveur qui n'ont aucune raison d'apparaître dans le code livré au navigateur. */
const SERVER_ONLY_NAMES = ['SECRETS_ENCRYPTION_KEY', 'SECRETS_ENCRYPTION_PREVIOUS_KEYS', 'SMTP_PASSWORD', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'TEST_DATABASE_URL'];
const SENSITIVE_ENV = /^(SECRETS_ENCRYPTION_KEY|SECRETS_ENCRYPTION_PREVIOUS_KEYS|SMTP_PASSWORD|SMTP_USER|POSTGRES_PASSWORD|DATABASE_URL|TEST_DATABASE_URL|.*_(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY))$/;

function scanBundle(findings) {
  const files = walk(BUNDLE_DIR).filter((f) => /\.(m?js|css|json|html|txt|map)$/.test(f));
  const envValues = Object.entries(process.env).filter(([name, value]) => SENSITIVE_ENV.test(name) && typeof value === 'string' && value.length >= 8);
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    const where = relative(ROOT, file);
    for (const name of SERVER_ONLY_NAMES) {
      const i = text.indexOf(name);
      if (i >= 0) findings.push({ where: `${where}:${lineOf(text, i)}`, rule: `nom de configuration serveur ${name} dans le bundle client`, value: name });
    }
    const pg = /postgres(ql)?:\/\/[^\s'"`]+/i.exec(text);
    if (pg) findings.push({ where: `${where}:${lineOf(text, pg.index)}`, rule: 'chaîne de connexion PostgreSQL dans le bundle client', value: pg[0] });
    for (const { rule, re } of TOKEN_RULES) {
      const m = re.exec(text);
      if (m) findings.push({ where: `${where}:${lineOf(text, m.index)}`, rule: `${rule} dans le bundle client`, value: m[0] });
    }
    for (const [name, value] of envValues) {
      const i = text.indexOf(value);
      if (i >= 0) findings.push({ where: `${where}:${lineOf(text, i)}`, rule: `valeur de la variable ${name} dans le bundle client`, value });
    }
  }
  return files.length;
}

const findings = [];
const report = [];
if (!BUNDLE_ONLY) report.push(`dépôt : ${scanRepository(findings)} fichiers texte contrôlés`);
if (existsSync(BUNDLE_DIR)) {
  report.push(`bundle client : ${scanBundle(findings)} fichiers contrôlés (${relative(ROOT, BUNDLE_DIR) || BUNDLE_DIR})`);
} else if (REQUIRE_BUNDLE) {
  process.stderr.write(`Contrôle des secrets : bundle client absent (${BUNDLE_DIR}) ; construisez d’abord le frontend (pnpm --filter @parc-auto/web build).\n`);
  process.exit(1);
} else {
  report.push('bundle client : non construit, non contrôlé');
}

if (findings.length > 0) {
  process.stderr.write(`Contrôle des secrets : ${findings.length} secret(s) potentiel(s) trouvé(s).\n`);
  for (const f of findings) process.stderr.write(`  ${f.where} — ${f.rule} (${mask(f.value)})\n`);
  process.stderr.write('Retirez la valeur (variable d’environnement, .env non versionné) ; un exemple doit rester vide ou interpolé.\n');
  process.exit(1);
}
process.stdout.write(`Contrôle des secrets : aucun secret trouvé — ${report.join(' ; ')}.\n`);
