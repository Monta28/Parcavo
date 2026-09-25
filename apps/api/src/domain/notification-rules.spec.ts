import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  acceptsImmediateEmail,
  buildActionUrl,
  checkQueuedAlertEmail,
  checkQueuedDigest,
  criticalAlertDedupeKey,
  dailyDigestDedupeKey,
  digestTiming,
  immediateEmailSeverities,
  isEmailRecipientRole,
  redactDeliveryError,
  renderCriticalAlertEmail,
  renderDailyDigestEmail,
} from './notification-rules.js';
import { localDate } from './civil-date.js';

const TZ = 'Africa/Tunis';

describe('règles de notification e-mail (CDC 9.4 — D-244 à D-246, D-253, D-261 à D-263)', () => {
  it('e-mails réservés au chef de parc et à l’administrateur', () => {
    expect(isEmailRecipientRole('ADMIN')).toBe(true);
    expect(isEmailRecipientRole('CHEF_PARC')).toBe(true);
    expect(isEmailRecipientRole('OPERATEUR')).toBe(false);
    expect(isEmailRecipientRole('LECTEUR')).toBe(false);
    expect(isEmailRecipientRole('CONDUCTEUR')).toBe(false);
  });

  it('e-mail immédiat : CRITIQUE seulement par défaut (D-246) ; gravité minimale configurable par l’utilisateur (D-245)', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCE.minimumSeverity).toBe('CRITIQUE');
    expect(acceptsImmediateEmail(DEFAULT_NOTIFICATION_PREFERENCE, 'CRITIQUE')).toBe(true);
    expect(acceptsImmediateEmail(DEFAULT_NOTIFICATION_PREFERENCE, 'URGENT')).toBe(false);
    expect(immediateEmailSeverities(DEFAULT_NOTIFICATION_PREFERENCE)).toEqual(['CRITIQUE']);
    // Une gravité minimale abaissée étend l'envoi immédiat (9.4 : gravités notifiées configurables).
    const attention = { emailCritical: true, emailDailyDigest: true, minimumSeverity: 'ATTENTION' as const };
    expect(acceptsImmediateEmail(attention, 'URGENT')).toBe(true);
    expect(acceptsImmediateEmail(attention, 'ATTENTION')).toBe(true);
    expect(acceptsImmediateEmail(attention, 'INFO')).toBe(false);
    expect(immediateEmailSeverities(attention)).toEqual(['CRITIQUE', 'URGENT', 'ATTENTION']);
    // E-mail immédiat désactivé : aucune gravité.
    const off = { emailCritical: false, emailDailyDigest: true, minimumSeverity: 'INFO' as const };
    expect(acceptsImmediateEmail(off, 'CRITIQUE')).toBe(false);
    expect(immediateEmailSeverities(off)).toEqual([]);
  });

  it('clés de déduplication stables par alerte, activation, destinataire et gravité ; récapitulatif par jour', () => {
    const at = new Date('2026-09-24T10:00:00Z');
    expect(criticalAlertDedupeKey('a1', at, 'u1', 'CRITIQUE')).toBe(criticalAlertDedupeKey('a1', new Date(at), 'u1', 'CRITIQUE'));
    expect(criticalAlertDedupeKey('a1', at, 'u1', 'CRITIQUE')).not.toBe(criticalAlertDedupeKey('a1', at, 'u2', 'CRITIQUE'));
    expect(criticalAlertDedupeKey('a1', at, 'u1', 'CRITIQUE')).not.toBe(criticalAlertDedupeKey('a1', new Date('2026-09-25T10:00:00Z'), 'u1', 'CRITIQUE'));
    expect(dailyDigestDedupeKey('u1', '2026-09-24')).toBe('digest:u1:2026-09-24');
  });

  it('un récapitulatif en file n’est envoyable que le jour local qu’il couvre (D-262)', () => {
    const key = dailyDigestDedupeKey('u1', '2026-09-24');
    expect(checkQueuedDigest(key, 'u1', localDate(new Date('2026-09-24T22:59:00Z'), TZ))).toEqual({ current: true });
    expect(checkQueuedDigest(key, 'u1', localDate(new Date('2026-09-24T23:00:00Z'), TZ))).toEqual({ current: false, reason: 'Récapitulatif d’un autre jour : abandonné (D-262).' });
    expect(checkQueuedDigest(key, 'u2', '2026-09-24')).toMatchObject({ current: false });
    expect(checkQueuedDigest('digest:u1:2026-02-30', 'u1', '2026-02-30')).toMatchObject({ current: false });
  });

  it('un e-mail d’alerte en file devient obsolète si l’alerte est réactivée ou change de gravité', () => {
    const at = new Date('2026-09-24T10:00:00Z');
    const alertId = '0199aaaa-0000-7000-8000-000000000001';
    const userId = '0199aaaa-0000-7000-8000-000000000002';
    const key = criticalAlertDedupeKey(alertId, at, userId, 'URGENT');
    expect(checkQueuedAlertEmail(key, { id: alertId, triggeredAt: at, severity: 'URGENT' }, userId)).toEqual({ current: true });
    expect(checkQueuedAlertEmail(key, { id: alertId, triggeredAt: at, severity: 'CRITIQUE' }, userId)).toEqual({ current: false, reason: 'Gravité de l’alerte modifiée depuis la mise en file.' });
    expect(checkQueuedAlertEmail(key, { id: alertId, triggeredAt: new Date('2026-09-25T10:00:00Z'), severity: 'URGENT' }, userId)).toEqual({
      current: false,
      reason: 'Alerte réactivée depuis la mise en file : un nouveau message la remplace.',
    });
    expect(checkQueuedAlertEmail(key, { id: alertId, triggeredAt: at, severity: 'URGENT' }, 'autre')).toMatchObject({ current: false });
    expect(checkQueuedAlertEmail(`test:${alertId}`, { id: alertId, triggeredAt: at, severity: 'URGENT' }, userId)).toMatchObject({ current: false });
    expect(checkQueuedAlertEmail(`alerte:${alertId}:abc:${userId}:URGENT`, { id: alertId, triggeredAt: at, severity: 'URGENT' }, userId)).toMatchObject({ current: false });
  });

  it('récapitulatif dû à partir de 08:00 locale le jour même ; jamais anticipé ni rattrapé le lendemain', () => {
    // 07:59 à Tunis (UTC+1) = 06:59 UTC.
    expect(digestTiming(new Date('2026-09-24T06:59:00Z'), TZ, '2026-09-24', '08:00')).toBe('TROP_TOT');
    expect(digestTiming(new Date('2026-09-24T07:00:00Z'), TZ, '2026-09-24', '08:00')).toBe('DU');
    // 23:59 locale : rattrapage encore possible ; 00:00 le lendemain : jour passé.
    expect(digestTiming(new Date('2026-09-24T22:59:00Z'), TZ, '2026-09-24', '08:00')).toBe('DU');
    expect(digestTiming(new Date('2026-09-24T23:00:00Z'), TZ, '2026-09-24', '08:00')).toBe('JOUR_PASSE');
    expect(digestTiming(new Date('2026-09-24T10:00:00Z'), TZ, '2026-09-25', '08:00')).toBe('JOUR_FUTUR');
    expect(digestTiming(new Date('2026-09-24T09:00:00Z'), TZ, '2026-09-24', '10:30')).toBe('TROP_TOT');
    expect(() => digestTiming(new Date('2026-09-24T09:00:00Z'), TZ, '2026-09-24', '8h')).toThrow();
  });

  it('lien vers l’action : chemin relatif uniquement, sinon centre d’alertes', () => {
    expect(buildActionUrl('https://parc.example.tn/', '/entretiens?plan=1')).toBe('https://parc.example.tn/entretiens?plan=1');
    expect(buildActionUrl('https://parc.example.tn', 'https://ailleurs.example')).toBe('https://parc.example.tn/alertes');
    expect(buildActionUrl('https://parc.example.tn', '//ailleurs.example')).toBe('https://parc.example.tn/alertes');
  });

  it('e-mail critique : texte brut, lien, sans message libre (pas de nom de conducteur ni montant)', () => {
    const mail = renderCriticalAlertEmail({
      type: 'ENTRETIEN_ECHEANCE',
      severity: 'CRITIQUE',
      companyName: 'Société A',
      vehicle: { code: 'V-001', registration: '123 TU 4567' },
      triggeredAt: new Date('2026-09-24T10:00:00Z'),
      timezone: TZ,
      actionUrl: 'http://localhost:3000/entretiens?plan=p1',
      alertCenterUrl: 'http://localhost:3000/alertes',
    });
    expect(mail.subject).toBe('[Parc Auto] Alerte critique — Échéance d’entretien — V-001');
    expect(mail.bodyText).toContain('Société : Société A');
    expect(mail.bodyText).toContain('Véhicule : V-001 (123 TU 4567)');
    expect(mail.bodyText).toContain('Déclenchée le : 24/09/2026 à 11:00 (heure locale)');
    expect(mail.bodyText).toContain('Action à mener : http://localhost:3000/entretiens?plan=p1');
    expect(mail.bodyText).not.toMatch(/TND|<[a-z]/i);
    const urgent = renderCriticalAlertEmail({
      type: 'RETOUR_DEPASSE',
      severity: 'URGENT',
      companyName: 'Société A',
      vehicle: null,
      triggeredAt: new Date('2026-09-24T10:00:00Z'),
      timezone: TZ,
      actionUrl: 'http://localhost:3000/utilisations/u1',
      alertCenterUrl: 'http://localhost:3000/alertes',
    });
    expect(urgent.subject).toBe('[Parc Auto] Alerte urgente — Retour dépassé');
    expect(urgent.bodyText).not.toContain('Véhicule :');
  });

  it('récapitulatif vide : aucun e-mail ; sinon groupé par gravité puis société, borné', () => {
    const base = { date: '2026-09-24', timezone: TZ, alertCenterUrl: 'http://x/alertes' };
    expect(renderDailyDigestEmail({ ...base, alerts: [], expectedReturns: [], pendingSubmissions: 0 })).toBeNull();
    const at = new Date('2026-09-20T08:00:00Z');
    const mail = renderDailyDigestEmail({
      ...base,
      alerts: [
        { severity: 'ATTENTION', type: 'KILOMETRAGE_ANCIEN', companyName: 'Société B', vehicle: { code: 'V-2', registration: 'R2' }, triggeredAt: at, actionUrl: 'http://x/a2' },
        { severity: 'CRITIQUE', type: 'ENTRETIEN_ECHEANCE', companyName: 'Société A', vehicle: { code: 'V-1', registration: 'R1' }, triggeredAt: at, actionUrl: 'http://x/a1' },
        { severity: 'CRITIQUE', type: 'DOCUMENT_MANQUANT', companyName: 'Société A', vehicle: null, triggeredAt: at, actionUrl: 'http://x/a3' },
      ],
      expectedReturns: [{ companyName: 'Société A', vehicle: { code: 'V-1', registration: 'R1' }, expectedReturnAt: new Date('2026-09-24T16:00:00Z') }],
      pendingSubmissions: 2,
      maxAlertLines: 2,
    });
    expect(mail).not.toBeNull();
    expect(mail?.subject).toBe('[Parc Auto] Récapitulatif du 24/09/2026 — 3 alerte(s) active(s)');
    const body = mail?.bodyText ?? '';
    expect(body.indexOf('CRITIQUE (2)')).toBeGreaterThan(-1);
    expect(body).not.toContain('ATTENTION (1)');
    expect(body).toContain('… et 1 autre(s) alerte(s)');
    expect(body).toContain('  - Société A — V-1 (R1) à 17:00');
    expect(body).toContain('Soumissions en attente de validation : 2');
    expect(renderDailyDigestEmail({ ...base, alerts: [], expectedReturns: [], pendingSubmissions: 1 })?.bodyText).toContain('Aucune alerte active.');
  });

  it('erreur d’envoi expurgée : aucun secret, texte borné', () => {
    expect(redactDeliveryError(null)).toBeNull();
    const redacted = redactDeliveryError('Invalid login: 535 AUTH PLAIN AGFsaWNlAHNlY3JldA== rejected for smtp://alice:s3cret@mail.example password=hunter2 link ?token=abc123&x=1') ?? '';
    expect(redacted).not.toContain('s3cret');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('AGFsaWNlAHNlY3JldA==');
    expect(redacted).toContain('[expurgé]');
    // Valeur courte, en-tête d'autorisation et secret JSON, via l'assainissement commun complété.
    const other = redactDeliveryError('pwd=abc Authorization: Bearer eyJhbGciOi.payload.sig {"password":"p@ss"}') ?? '';
    expect(other).not.toMatch(/abc|eyJhbGciOi|p@ss/);
    expect(redactDeliveryError('x'.repeat(800))?.length).toBe(500);
  });
});
