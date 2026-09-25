import { PASSWORD_RESET_LINK_TTL_MINUTES, SETTING_DEFAULTS, SETTING_DESCRIPTORS } from '@parc-auto/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPORT_ABANDON_AFTER_DAYS, IMPORT_DATA_RETENTION_DAYS } from './modules/imports/import-retention.service.js';
import { ReportExportPolicy } from './modules/reports/export/report-export.policy.js';

/**
 * CDC 16.2 : la conservation est définie et documentée (docs/conservation-des-donnees.md), sans annoncer
 * de conformité juridique. Chaque durée du document est comparée à la valeur réellement appliquée par le
 * code : une durée modifiée dans le code sans mise à jour du document fait échouer ce test.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOC = readFileSync(join(ROOT, 'docs/conservation-des-donnees.md'), 'utf8');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Valeur numérique d'une constante « const NOM = expression » (produit de facteurs entiers). */
function constant(path: string, name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*([\\d_\\s*]+);`).exec(source(path));
  if (!m?.[1]) throw new Error(`${name} introuvable dans ${path}`);
  return m[1].split('*').reduce((acc, f) => acc * Number(f.trim().replace(/_/g, '')), 1);
}

/** Ligne du tableau des durées dont la première cellule commence par ce libellé. */
function row(label: string): string {
  const line = DOC.split('\n').find((l) => l.startsWith(`| ${label}`));
  if (!line) throw new Error(`Ligne « ${label} » absente de docs/conservation-des-donnees.md`);
  return line;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Conservation des données : document fidèle au code (docs/conservation-des-donnees.md)', () => {
  it('sessions, liens d’accès, tentatives de connexion et idempotence', () => {
    expect(row('Session de connexion')).toContain(`${SETTING_DEFAULTS['session.ttlHours']} h par défaut, paramètre \`session.ttlHours\` (${SETTING_DESCRIPTORS['session.ttlHours'].min} à ${SETTING_DESCRIPTORS['session.ttlHours'].max} h`);
    expect(source('apps/api/src/modules/auth/session.service.ts')).toMatch(/settings\.get\(user\.organizationId, 'session\.ttlHours'\)/);
    expect(source('apps/api/src/modules/auth/session.service.ts')).toContain('- 30 * 24 * 3600 * 1000');
    expect(row('Ligne de session expirée')).toContain('30 jours');
    // Durée partagée avec l'écran « Mot de passe oublié » (packages/contracts), appliquée telle quelle par l'API.
    expect(PASSWORD_RESET_LINK_TTL_MINUTES).toBe(30);
    expect(source('apps/api/src/modules/auth/auth.service.ts')).toContain('const RESET_TOKEN_TTL_MS = PASSWORD_RESET_LINK_TTL_MINUTES * 60 * 1000;');
    expect(row('Lien de réinitialisation')).toContain(`${PASSWORD_RESET_LINK_TTL_MINUTES} minutes`);
    expect(source('apps/api/src/modules/users/users.service.ts')).toContain("purpose === 'INVITATION' ? 72 * 3600 * 1000");
    expect(row('Lien d\'invitation')).toContain('72 heures');
    expect(constant('apps/api/src/modules/auth/auth.service.ts', 'LOCKOUT_WINDOW_MS')).toBe(15 * 60_000);
    expect(constant('apps/worker/src/jobs/daily-purge.job.ts', 'LOGIN_ATTEMPT_RETENTION_DAYS')).toBe(30);
    expect(row('Tentatives de connexion')).toContain('15 minutes ; lignes conservées 30 jours');
    expect(constant('apps/api/src/common/idempotency.service.ts', 'RETENTION_HOURS')).toBe(24);
    expect(row('Clés d\'idempotence')).toContain('24 heures');
  });

  it('fichiers temporaires, exports, imports et traces du worker', () => {
    expect(constant('apps/api/src/modules/attachments/attachments.service.ts', 'TEMP_TTL_MS')).toBe(DAY);
    expect(row('Fichier temporaire')).toContain('24 heures');
    expect(new ReportExportPolicy().retentionMs).toBe(DAY);
    expect(row('Fichier d\'export')).toContain('24 heures');
    expect(constant('apps/worker/src/jobs/job-queue.job.ts', 'EXPORT_PURGE_INTERVAL_MS')).toBe(15 * 60_000);
    expect(row('Fichier d\'export')).toContain('toutes les 15 minutes');
    expect(IMPORT_ABANDON_AFTER_DAYS).toBe(7);
    expect(row('Lot d\'import non confirmé')).toContain(`${IMPORT_ABANDON_AFTER_DAYS} jours`);
    expect(IMPORT_DATA_RETENTION_DAYS).toBe(90);
    expect(row('Valeurs brutes des lignes')).toContain(`${IMPORT_DATA_RETENTION_DAYS} jours`);
    expect(constant('apps/worker/src/jobs/daily-purge.job.ts', 'SCHEDULED_RUN_RETENTION_DAYS')).toBe(30);
    expect(row('Traces des traitements planifiés')).toContain('30 jours');
  });

  it('sauvegardes : rétention par défaut du script ; aucune conformité juridique annoncée ; points à valider listés', () => {
    expect(source('scripts/ops/backup.sh')).toContain('RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"');
    expect(row('Sauvegardes')).toContain('30 jours, variable `BACKUP_RETENTION_DAYS`');
    expect(DOC).toContain('aucune conformité à une réglementation particulière');
    expect(DOC).not.toMatch(/conforme (au|à la) (RGPD|loi)/i);
    const pending = DOC.slice(DOC.indexOf('## À valider avec le client'));
    expect(pending.match(/^\d+\. /gm)?.length).toBeGreaterThanOrEqual(5);
  });
});
