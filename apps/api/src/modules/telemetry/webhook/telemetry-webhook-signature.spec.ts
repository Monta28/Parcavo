import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkSignedHeaders, matchesAnySecret, sha256Hex, webhookSignature, webhookSignatureHeader } from './telemetry-webhook-signature.js';

const SECRET = 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD';
const OTHER = 'whsec_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwvu';
const NOW = new Date('2026-09-24T10:00:00.000Z');
const TS = String(NOW.getTime() / 1000);
const BODY = Buffer.from('{"version":1,"odometers":[]}', 'utf8');

describe('Signature des lots webhook (D-298, R-14.4-X01)', () => {
  it('HMAC-SHA256 hexadécimal de « <horodatage>.<corps brut> » (octets exacts)', () => {
    const expected = createHmac('sha256', SECRET).update(`${TS}.{"version":1,"odometers":[]}`).digest('hex');
    expect(webhookSignature(SECRET, TS, BODY)).toBe(expected);
    expect(webhookSignatureHeader(SECRET, TS, BODY)).toBe(`sha256=${expected}`);
    expect(sha256Hex(BODY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepte une signature valide, y compris parmi plusieurs valeurs, et un ancien secret encore admis', () => {
    const checked = checkSignedHeaders(TS, `sha256=${'0'.repeat(64)}, ${webhookSignatureHeader(SECRET, TS, BODY)}`, NOW, 300);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.headers.signedAt.toISOString()).toBe(NOW.toISOString());
    expect(matchesAnySecret([SECRET], checked.headers, BODY)).toBe(true);
    expect(matchesAnySecret([OTHER, SECRET], checked.headers, BODY)).toBe(true);
    expect(matchesAnySecret([OTHER], checked.headers, BODY)).toBe(false);
    expect(matchesAnySecret([], checked.headers, BODY)).toBe(false);
  });

  it('refuse un corps modifié, un horodatage modifié et une signature mal formée', () => {
    const header = webhookSignatureHeader(SECRET, TS, BODY);
    const checked = checkSignedHeaders(TS, header, NOW, 300);
    expect(checked.ok && matchesAnySecret([SECRET], checked.headers, Buffer.from('{"version":1,"odometers":[ ]}'))).toBe(false);
    const shifted = String(Number(TS) + 1);
    const moved = checkSignedHeaders(shifted, header, NOW, 300);
    expect(moved.ok && matchesAnySecret([SECRET], moved.headers, BODY)).toBe(false);
    expect(checkSignedHeaders(TS, header.replace('sha256=', 'sha1='), NOW, 300)).toEqual({ ok: false, reason: 'SIGNATURE_INVALIDE' });
    expect(checkSignedHeaders(TS, 'sha256=abc', NOW, 300)).toEqual({ ok: false, reason: 'SIGNATURE_INVALIDE' });
  });

  it('en-têtes absents, horodatage illisible ou hors de la fenêtre de tolérance (passé ou futur)', () => {
    const header = webhookSignatureHeader(SECRET, TS, BODY);
    expect(checkSignedHeaders(undefined, header, NOW, 300)).toEqual({ ok: false, reason: 'SIGNATURE_ABSENTE' });
    expect(checkSignedHeaders(TS, undefined, NOW, 300)).toEqual({ ok: false, reason: 'SIGNATURE_ABSENTE' });
    expect(checkSignedHeaders('  ', header, NOW, 300)).toEqual({ ok: false, reason: 'SIGNATURE_ABSENTE' });
    expect(checkSignedHeaders([TS, TS], header, NOW, 300)).toEqual({ ok: false, reason: 'SIGNATURE_ABSENTE' });
    expect(checkSignedHeaders('2026-09-24T10:00:00Z', header, NOW, 300)).toEqual({ ok: false, reason: 'HORODATAGE_INVALIDE' });
    expect(checkSignedHeaders(String(Number(TS) - 301), header, NOW, 300)).toEqual({ ok: false, reason: 'SIGNATURE_EXPIREE' });
    expect(checkSignedHeaders(String(Number(TS) + 301), header, NOW, 300)).toEqual({ ok: false, reason: 'SIGNATURE_EXPIREE' });
    expect(checkSignedHeaders(String(Number(TS) - 300), header, NOW, 300).ok).toBe(true);
  });
});
