import { describe, expect, it } from 'vitest';
import { REDACTED, describeErrorSafely, redactDeep, redactSensitiveText, sanitizeUrl, secretVariants, trackSensitiveValues } from './secret-redaction.js';

describe('Assainissement des secrets (D-304, T44)', () => {
  it('masque les paramètres d’URL sensibles, les identifiants intégrés et les en-têtes', () => {
    const text = 'GET https://admin:S3cr3t!@traccar.example.tn/api/devices?token=abcDEF123&all=true puis sid=0123456789abcdef ; Authorization: Bearer eyJhbGciOi.xyz';
    const out = redactSensitiveText(text);
    expect(out).not.toContain('S3cr3t!');
    expect(out).not.toContain('abcDEF123');
    expect(out).not.toContain('0123456789abcdef');
    expect(out).not.toContain('eyJhbGciOi.xyz');
    expect(out).toContain('traccar.example.tn/api/devices');
    expect(out).toContain('all=true');
  });

  it('masque un jeton Wialon passé en JSON, brut ou encodé dans le paramètre params', () => {
    const raw = 'svc=token/login&params={"token":"f00dbabe1234","fl":1}';
    const encoded = `https://hst-api.wialon.com/wialon/ajax.html?svc=token/login&params=${encodeURIComponent('{"token":"f00dbabe1234"}')}`;
    expect(redactSensitiveText(raw)).not.toContain('f00dbabe1234');
    expect(redactSensitiveText(encoded)).not.toContain('f00dbabe1234');
    expect(sanitizeUrl(encoded)).not.toContain('f00dbabe1234');
  });

  it('remplace les valeurs secrètes connues sous leurs formes usuelles (brute, URL, base64, parties)', () => {
    const secret = 'utilisateur@exemple.tn:Mot de passe/très+secret';
    const b64 = Buffer.from(secret).toString('base64');
    const text = `a=${secret} b=${encodeURIComponent(secret)} c=Basic ${b64} d=Mot de passe/très+secret`;
    const out = redactSensitiveText(text, [secret]);
    expect(out).not.toContain('Mot de passe/très+secret');
    expect(out).not.toContain(encodeURIComponent('Mot de passe/très+secret'));
    expect(out).not.toContain(b64);
    expect(secretVariants(['abc'])).toEqual([]);
  });

  it('secrets suivis pendant un appel : masqués jusqu’à la libération', () => {
    const release = trackSensitiveValues(['JETON-SENTINELLE-42']);
    expect(redactSensitiveText('erreur avec JETON-SENTINELLE-42 dans le texte')).toBe(`erreur avec ${REDACTED} dans le texte`);
    release();
    expect(redactSensitiveText('JETON-SENTINELLE-42')).toBe('JETON-SENTINELLE-42');
  });

  it('parties sensibles d’un secret JSON (IMAP/SFTP) et objets de journal', () => {
    const secret = JSON.stringify({ user: 'lecteur', password: 'pw-Sentinelle-99' });
    expect(redactSensitiveText('échec pw-Sentinelle-99', [secret])).not.toContain('pw-Sentinelle-99');
    expect(redactDeep({ message: 'ok', params: { password: 'x', nested: ['token=abcd1234'] } })).toEqual({ message: 'ok', params: { password: REDACTED, nested: [`token=${REDACTED}`] } });
  });

  it('message d’erreur borné et assaini', () => {
    const message = describeErrorSafely(new Error(`échec ?token=zzzz9999 ${'x'.repeat(1000)}`));
    expect(message).not.toContain('zzzz9999');
    expect(message.length).toBeLessThanOrEqual(500);
  });
});
