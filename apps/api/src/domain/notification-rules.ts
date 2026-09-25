import type { AlertSeverity, AlertType, MembershipRole } from '@parc-auto/db';
import { DateTime } from 'luxon';
import { REDACTED, redactSensitiveText } from '../common/secret-redaction.js';
import { ALERT_TYPE_LABELS, SEVERITIES_DESC, SEVERITY_LABELS, SEVERITY_RANK, severityAtLeast } from './alert-policy.js';
import { assertCivilDate, compareCivil, formatCivilDate, localDate as localDateOf, type CivilDate, formatLocalDateTime } from './civil-date.js';

/**
 * Règles des notifications e-mail (CDC 9.4) — implémentation unique, sans accès aux données.
 *  - E-mails réservés aux chefs de parc et administrateurs (D-244).
 *  - E-mail immédiat si la gravité atteint la gravité minimale choisie par l'utilisateur (D-245) ; par
 *    défaut CRITIQUE, donc seules les alertes critiques partent immédiatement et les autres figurent dans le
 *    récapitulatif (grille par défaut D-246). Les gravités notifiées sont configurables (9.4, R-9.4-04).
 *  - Préférence par défaut : e-mail immédiat à partir de CRITIQUE, récapitulatif actif (D-245).
 *  - Clés de déduplication stables : une ligne d'outbox par alerte, activation, destinataire et gravité
 *    (D-253) ; un récapitulatif par utilisateur et date locale (D-262, D-263).
 *  - Contenu : texte brut et lien vers l'action, sans pièce jointe, sans montant, sans donnée personnelle
 *    de conducteur (D-261) : seuls le type, la gravité, la société et le véhicule sont cités.
 */

export interface NotificationPreferenceValues {
  emailCritical: boolean;
  emailDailyDigest: boolean;
  minimumSeverity: AlertSeverity;
}

/** D-245 : défaut CRITIQUE (le défaut URGENT du schéma n'est pas retenu pour un compte sans préférence). */
export const DEFAULT_NOTIFICATION_PREFERENCE: Readonly<NotificationPreferenceValues> = { emailCritical: true, emailDailyDigest: true, minimumSeverity: 'CRITIQUE' };

/** D-244 : seuls ces rôles reçoivent des e-mails d'alerte et le récapitulatif. */
export const EMAIL_RECIPIENT_ROLES: readonly MembershipRole[] = ['ADMIN', 'CHEF_PARC'];

/** Nombre maximal d'alertes détaillées dans un récapitulatif ; le reste est renvoyé au centre d'alertes. */
export const DIGEST_MAX_ALERT_LINES = 100;

export function isEmailRecipientRole(role: MembershipRole): boolean {
  return EMAIL_RECIPIENT_ROLES.includes(role);
}

/**
 * L'alerte de cette gravité part-elle immédiatement vers ce destinataire ? Oui si l'e-mail immédiat est
 * actif et que la gravité atteint sa gravité minimale (D-245 ; défaut CRITIQUE conforme à D-246).
 */
export function acceptsImmediateEmail(preference: NotificationPreferenceValues, severity: AlertSeverity): boolean {
  return preference.emailCritical && severityAtLeast(severity, preference.minimumSeverity);
}

/** Gravités envoyées immédiatement à ce destinataire, de la plus haute à la plus basse. */
export function immediateEmailSeverities(preference: NotificationPreferenceValues): AlertSeverity[] {
  return SEVERITIES_DESC.filter((s) => acceptsImmediateEmail(preference, s));
}

/** Qualificatif de l'objet d'un e-mail immédiat (« Alerte critique », « Alerte urgente »…). */
const SUBJECT_QUALIFIER: Readonly<Record<AlertSeverity, string>> = {
  CRITIQUE: 'critique',
  URGENT: 'urgente',
  ATTENTION: '« Attention »',
  INFO: 'd’information',
};

export function criticalAlertDedupeKey(alertId: string, activatedAt: Date, userId: string, severity: AlertSeverity): string {
  return `alerte:${alertId}:${activatedAt.getTime()}:${userId}:${severity}`;
}

export interface CriticalAlertKeyParts {
  alertId: string;
  activatedAtMs: number;
  userId: string;
  severity: AlertSeverity;
}

/** Relit la clé d'un e-mail d'alerte : activation et gravité pour lesquelles il a été mis en file. */
export function parseCriticalAlertDedupeKey(key: string): CriticalAlertKeyParts | null {
  const parts = key.split(':');
  if (parts.length !== 5 || parts[0] !== 'alerte') return null;
  const [, alertId, activated, userId, severity] = parts as [string, string, string, string, string];
  const activatedAtMs = Number(activated);
  if (!alertId || !userId || !/^\d+$/.test(activated) || !Number.isSafeInteger(activatedAtMs) || !(severity in SEVERITY_RANK)) return null;
  return { alertId, activatedAtMs, userId, severity: severity as AlertSeverity };
}

export type QueuedAlertCheck = { current: true } | { current: false; reason: string };

/**
 * Un e-mail d'alerte en file est-il toujours d'actualité (D-261 : contenu revérifié avant l'envoi) ? Il
 * porte sur une activation et une gravité précises : une réactivation ou un changement de gravité le
 * rend obsolète (l'escalade a mis en file son propre message ; une baisse ne doit pas annoncer l'ancienne
 * gravité).
 */
export function checkQueuedAlertEmail(dedupeKey: string, alert: { id: string; triggeredAt: Date; severity: AlertSeverity }, recipientUserId: string): QueuedAlertCheck {
  const key = parseCriticalAlertDedupeKey(dedupeKey);
  if (!key || key.alertId !== alert.id || key.userId !== recipientUserId) return { current: false, reason: 'Message d’alerte sans référence valide.' };
  if (key.activatedAtMs !== alert.triggeredAt.getTime()) return { current: false, reason: 'Alerte réactivée depuis la mise en file : un nouveau message la remplace.' };
  if (key.severity !== alert.severity) return { current: false, reason: 'Gravité de l’alerte modifiée depuis la mise en file.' };
  return { current: true };
}

export function dailyDigestDedupeKey(userId: string, date: CivilDate): string {
  return `digest:${userId}:${date}`;
}

/**
 * Un récapitulatif en file est-il encore envoyable (D-262 : rattrapage jusqu'à 23:59 locale, puis abandon
 * du jour) ? Il doit appartenir au destinataire et à la date locale courante.
 */
export function checkQueuedDigest(dedupeKey: string, recipientUserId: string, today: CivilDate): QueuedAlertCheck {
  const match = /^digest:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(dedupeKey);
  if (!match || match[1] !== recipientUserId) return { current: false, reason: 'Récapitulatif sans référence valide.' };
  const date = match[2] as string;
  try {
    assertCivilDate(date);
  } catch {
    return { current: false, reason: 'Récapitulatif sans référence valide.' };
  }
  if (compareCivil(date, today) !== 0) return { current: false, reason: 'Récapitulatif d’un autre jour : abandonné (D-262).' };
  return { current: true };
}

export type DigestTiming = 'DU' | 'TROP_TOT' | 'JOUR_PASSE' | 'JOUR_FUTUR';

/**
 * Moment du récapitulatif (D-262) : dû à partir de l'heure d'envoi locale du jour concerné et jusqu'à
 * 23:59 locale ; un jour passé est abandonné, un jour futur n'est jamais anticipé.
 */
export function digestTiming(now: Date, timezone: string, date: CivilDate, sendLocalTime: string): DigestTiming {
  assertCivilDate(date);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(sendLocalTime);
  if (!match) throw new Error(`Heure d'envoi invalide : ${sendLocalTime}`);
  const today = localDateOf(now, timezone);
  const cmp = compareCivil(date, today);
  if (cmp < 0) return 'JOUR_PASSE';
  if (cmp > 0) return 'JOUR_FUTUR';
  const sendAt = DateTime.fromISO(date, { zone: timezone }).set({ hour: Number(match[1]), minute: Number(match[2]), second: 0, millisecond: 0 });
  return now.getTime() < sendAt.toMillis() ? 'TROP_TOT' : 'DU';
}

/** Lien absolu vers l'action utile ; un chemin non relatif est remplacé par le centre d'alertes. */
export function buildActionUrl(appOrigin: string, actionPath: string | null | undefined): string {
  const origin = appOrigin.replace(/\/+$/, '');
  const path = actionPath && actionPath.startsWith('/') && !actionPath.startsWith('//') ? actionPath : '/alertes';
  return `${origin}${path}`;
}

export interface VehicleLabel {
  code: string;
  registration: string;
}

export interface RenderedEmail {
  subject: string;
  bodyText: string;
}

const FOOTER = 'Ce message ne contient ni pièce jointe, ni montant, ni donnée personnelle. Consultez le détail dans l’application.';

function vehicleText(vehicle: VehicleLabel | null): string | null {
  return vehicle ? `${vehicle.code} (${vehicle.registration})` : null;
}


export interface CriticalAlertEmailInput {
  type: AlertType;
  severity: AlertSeverity;
  companyName: string;
  vehicle: VehicleLabel | null;
  triggeredAt: Date;
  timezone: string;
  actionUrl: string;
  alertCenterUrl: string;
}

/** E-mail immédiat d'une alerte (texte brut, lien vers l'action). */
export function renderCriticalAlertEmail(input: CriticalAlertEmailInput): RenderedEmail {
  const typeLabel = ALERT_TYPE_LABELS[input.type];
  const vehicle = vehicleText(input.vehicle);
  const subject = `[Parc Auto] Alerte ${SUBJECT_QUALIFIER[input.severity]} — ${typeLabel}${input.vehicle ? ` — ${input.vehicle.code}` : ''}`;
  const lines = [
    'Bonjour,',
    '',
    `Une alerte de gravité « ${SEVERITY_LABELS[input.severity]} » requiert votre attention.`,
    '',
    `Type : ${typeLabel}`,
    `Gravité : ${SEVERITY_LABELS[input.severity]}`,
    `Société : ${input.companyName}`,
    ...(vehicle ? [`Véhicule : ${vehicle}`] : []),
    `Déclenchée le : ${formatLocalDateTime(input.triggeredAt, input.timezone, { sentence: true })} (heure locale)`,
    '',
    `Action à mener : ${input.actionUrl}`,
    `Centre d’alertes : ${input.alertCenterUrl}`,
    '',
    FOOTER,
  ];
  return { subject, bodyText: `${lines.join('\n')}\n` };
}

export interface DigestAlertLine {
  severity: AlertSeverity;
  type: AlertType;
  companyName: string;
  vehicle: VehicleLabel | null;
  triggeredAt: Date;
  actionUrl: string;
}

export interface DigestReturnLine {
  companyName: string;
  vehicle: VehicleLabel;
  expectedReturnAt: Date;
}

export interface DailyDigestInput {
  date: CivilDate;
  timezone: string;
  alerts: readonly DigestAlertLine[];
  expectedReturns: readonly DigestReturnLine[];
  pendingSubmissions: number;
  alertCenterUrl: string;
  maxAlertLines?: number;
}

/**
 * Récapitulatif quotidien (D-262) : alertes actives non reportées groupées par gravité puis société,
 * retours attendus du jour et nombre de soumissions en attente. Null si le récapitulatif est vide
 * (aucun envoi).
 */
export function renderDailyDigestEmail(input: DailyDigestInput): RenderedEmail | null {
  if (input.alerts.length === 0 && input.expectedReturns.length === 0 && input.pendingSubmissions === 0) return null;
  const maxLines = input.maxAlertLines ?? DIGEST_MAX_ALERT_LINES;
  const sorted = [...input.alerts].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.companyName.localeCompare(b.companyName, 'fr') || a.triggeredAt.getTime() - b.triggeredAt.getTime(),
  );
  const shown = sorted.slice(0, maxLines);
  const dateText = formatCivilDate(input.date);
  const lines: string[] = ['Bonjour,', '', `Récapitulatif du ${dateText} pour votre périmètre (alertes que vous avez reportées exclues).`, ''];
  if (sorted.length === 0) {
    lines.push('Aucune alerte active.', '');
  } else {
    lines.push(`Alertes actives : ${sorted.length}`, '');
    for (const severity of SEVERITIES_DESC) {
      const group = shown.filter((a) => a.severity === severity);
      if (group.length === 0) continue;
      const total = sorted.filter((a) => a.severity === severity).length;
      lines.push(`${SEVERITY_LABELS[severity].toUpperCase()} (${total})`);
      let company: string | null = null;
      for (const a of group) {
        if (a.companyName !== company) {
          company = a.companyName;
          lines.push(`  ${company}`);
        }
        const vehicle = vehicleText(a.vehicle);
        lines.push(`  - ${ALERT_TYPE_LABELS[a.type]}${vehicle ? ` — ${vehicle}` : ''} : ${a.actionUrl}`);
      }
      lines.push('');
    }
    if (sorted.length > shown.length) {
      lines.push(`… et ${sorted.length - shown.length} autre(s) alerte(s) à consulter dans le centre d’alertes.`, '');
    }
  }
  if (input.expectedReturns.length > 0) {
    lines.push(`Retours attendus aujourd’hui (${input.expectedReturns.length})`);
    const returns = [...input.expectedReturns].sort((a, b) => a.expectedReturnAt.getTime() - b.expectedReturnAt.getTime());
    for (const r of returns) {
      lines.push(`  - ${r.companyName} — ${vehicleText(r.vehicle) ?? ''} à ${DateTime.fromJSDate(r.expectedReturnAt, { zone: input.timezone }).toFormat('HH:mm')}`);
    }
    lines.push('');
  }
  if (input.pendingSubmissions > 0) {
    lines.push(`Soumissions en attente de validation : ${input.pendingSubmissions}`, '');
  }
  lines.push(`Centre d’alertes : ${input.alertCenterUrl}`, '', FOOTER);
  const subject = `[Parc Auto] Récapitulatif du ${dateText} — ${sorted.length} alerte(s) active(s)`;
  return { subject, bodyText: `${lines.join('\n')}\n` };
}

/**
 * Erreur d'envoi expurgée (9.4, D-261) : assainissement commun (secret-redaction : identifiants d'URL,
 * paramètres et champs sensibles, secrets suivis), complété des échanges d'authentification SMTP
 * (AUTH PLAIN/LOGIN en base64) et des valeurs sensibles courtes ; texte compacté et borné.
 */
export function redactDeliveryError(message: string | null | undefined, maxLength = 500): string | null {
  if (!message) return null;
  let out = redactSensitiveText(message)
    .replace(/\bAUTH\s+(PLAIN|LOGIN|XOAUTH2|CRAM-MD5)\s+(?!\[expurgé\])\S+/gi, `AUTH $1 ${REDACTED}`)
    .replace(/\b(pass(?:word)?|pwd|secret|token|authorization)\b(\s*[:=]\s*)(?!\[expurgé\])\S+/gi, `$1$2${REDACTED}`)
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > maxLength) out = `${out.slice(0, maxLength - 1)}…`;
  return out;
}
