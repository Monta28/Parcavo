import { describe, expect, it } from 'vitest';
import {
  isSensitiveAuditKey,
  looksLikeSecretValue,
  sanitizeAuditValue,
} from './audit-redaction.js';
import { REDACTED } from './secret-redaction.js';

describe('expurgation des valeurs d’audit (CDC 16.1, D-109)', () => {
  it('reconnaît les clés sensibles quelle que soit la casse ou la forme', () => {
    for (const key of [
      'password',
      'newPassword',
      'passwordHash',
      'Passwd',
      'pwd',
      'pass',
      'passphrase',
      'token',
      'accessToken',
      'refresh_token',
      'tokenHash',
      'csrfTokenHash',
      'secret',
      'clientSecret',
      'hash',
      'ciphertext',
      'iv',
      'authTag',
      'Authorization',
      'cookie',
      'credentials',
      'apiKey',
      'api_key',
      'privateKey',
      'accessKey',
      'signature',
      'sid',
      'otp',
      'pin',
    ]) {
      expect(isSensitiveAuditKey(key), key).toBe(true);
    }
  });

  it('ne masque pas les clés métier ordinaires', () => {
    for (const key of [
      'key',
      'value',
      'kind',
      'status',
      'companyId',
      'physicalKm',
      'reason',
      'settingsKeys',
      'sha256',
      'fileName',
      'configured',
      'passengerCount',
      'email',
      'expiresAt',
      'credentialKind',
    ]) {
      expect(isSensitiveAuditKey(key), key).toBe(false);
    }
  });

  it('masque les clés sensibles à toute profondeur, y compris dans les tableaux', () => {
    const input = {
      status: 'ACTIF',
      password: 'Motdepasse-123',
      nested: {
        token: 'abcd1234efgh',
        apiKey: 'k-123456',
        keep: 42,
        deeper: [{ secret: 's3cr3t-valeur', label: 'ok' }],
      },
      list: [{ passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$abc$def' }],
    };
    expect(sanitizeAuditValue(input)).toEqual({
      status: 'ACTIF',
      password: REDACTED,
      nested: {
        token: REDACTED,
        apiKey: REDACTED,
        keep: 42,
        deeper: [{ secret: REDACTED, label: 'ok' }],
      },
      list: [{ passwordHash: REDACTED }],
    });
  });

  it('masque une empreinte ou un jeton signé placé sous une clé anodine', () => {
    expect(looksLikeSecretValue('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(looksLikeSecretValue('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
    expect(looksLikeSecretValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl')).toBe(true);
    expect(looksLikeSecretValue('Vidange moteur')).toBe(false);
    expect(
      sanitizeAuditValue({
        note: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
        label: 'Vidange',
      }),
    ).toEqual({ note: REDACTED, label: 'Vidange' });
  });

  it('assainit les secrets intégrés dans du texte (URL avec identifiants, Bearer, clé=valeur)', () => {
    const out = sanitizeAuditValue({
      baseUrl: 'https://user:motdepasse@gps.example.com/api?token=abcdef123',
      message: 'Échec : Authorization: Bearer abcdefghijkl',
      detail: 'password=Secret-987',
    }) as Record<string, string>;
    expect(out.baseUrl).not.toContain('motdepasse');
    expect(out.baseUrl).not.toContain('abcdef123');
    expect(out.message).not.toContain('abcdefghijkl');
    expect(out.detail).not.toContain('Secret-987');
  });

  it('conserve nombres, booléens et null ; undefined devient null', () => {
    expect(sanitizeAuditValue({ n: 1.5, b: false, z: null, u: undefined })).toEqual({
      n: 1.5,
      b: false,
      z: null,
      u: null,
    });
    expect(sanitizeAuditValue(null)).toBeNull();
    expect(sanitizeAuditValue('texte ordinaire')).toBe('texte ordinaire');
  });
});
