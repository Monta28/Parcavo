import { describe, expect, it } from 'vitest';
import { WEBHOOK_SECRET_PREFIX, generateWebhookSecret, toBase64Url } from './webhook-secret';

describe('Secret de signature webhook généré dans le navigateur (D-298)', () => {
  it('32 octets aléatoires en base64url préfixé : 49 caractères imprimables sans espace, conformes au contrôle de l’API', () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(secret).toHaveLength(WEBHOOK_SECRET_PREFIX.length + 43);
    expect(secret).toMatch(/^[\x21-\x7e]{32,256}$/);
    expect(secret.slice(WEBHOOK_SECRET_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('deux générations successives diffèrent ; encodage base64url exact', () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(generateWebhookSecret((b) => b.fill(0))).toBe(`${WEBHOOK_SECRET_PREFIX}${'A'.repeat(43)}`);
  });
});
