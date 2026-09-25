import { describe, expect, it } from 'vitest';
import { BusinessRuleError } from '../common/errors.js';
import { loadEnv } from './env.js';
import { SecretsCryptoService } from './secrets-crypto.service.js';

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://t:t@localhost:1/t' };

describe('Trousseau de chiffrement des secrets fournisseur (D-304)', () => {
  it('ancienne clé : déchiffrement seul ; rechiffrement sous la clé active', () => {
    const before = new SecretsCryptoService(loadEnv({ ...base, SECRETS_ENCRYPTION_KEY: K1, SECRETS_ENCRYPTION_KEY_ID: 'k1' }));
    const stored = before.encrypt('jeton-fournisseur-123');
    expect(stored.keyId).toBe('k1');
    expect(stored.ciphertext.toString('utf8')).not.toContain('jeton-fournisseur-123');

    const rotating = new SecretsCryptoService(loadEnv({ ...base, SECRETS_ENCRYPTION_KEY: K2, SECRETS_ENCRYPTION_KEY_ID: 'k2', SECRETS_ENCRYPTION_PREVIOUS_KEYS: `k1:${K1}` }));
    expect(rotating.activeKeyId()).toBe('k2');
    expect(rotating.canDecrypt('k1')).toBe(true);
    expect(rotating.decrypt(stored)).toBe('jeton-fournisseur-123');
    const rotated = rotating.reencrypt(stored);
    expect(rotated.keyId).toBe('k2');
    expect(rotating.decrypt(rotated)).toBe('jeton-fournisseur-123');

    const after = new SecretsCryptoService(loadEnv({ ...base, SECRETS_ENCRYPTION_KEY: K2, SECRETS_ENCRYPTION_KEY_ID: 'k2' }));
    expect(after.decrypt(rotated)).toBe('jeton-fournisseur-123');
    expect(() => after.decrypt(stored)).toThrow(BusinessRuleError);
    expect(after.canDecrypt('k1')).toBe(false);
  });

  it('un chiffré altéré ou une mauvaise clé sous le même identifiant est refusé (GCM)', () => {
    const good = new SecretsCryptoService(loadEnv({ ...base, SECRETS_ENCRYPTION_KEY: K1 }));
    const stored = good.encrypt('secret');
    const tampered = { ...stored, ciphertext: Buffer.from(stored.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b))) };
    expect(() => good.decrypt(tampered)).toThrow();
    const wrong = new SecretsCryptoService(loadEnv({ ...base, SECRETS_ENCRYPTION_KEY: K2 }));
    expect(() => wrong.decrypt(stored)).toThrow();
  });

  it('format du trousseau validé sans jamais citer une clé', () => {
    const parse = (value: string, activeId = 'k2') => () => loadEnv({ ...base, SECRETS_ENCRYPTION_KEY: K2, SECRETS_ENCRYPTION_KEY_ID: activeId, SECRETS_ENCRYPTION_PREVIOUS_KEYS: value });
    expect(parse(`k1:${K1}, k0:${Buffer.alloc(32, 9).toString('base64')}`)().secretsPreviousKeys?.map((k) => k.keyId)).toEqual(['k1', 'k0']);
    expect(parse(K1)).toThrow(/entrée n° 1 invalide/);
    expect(parse('k1:AAAA')).toThrow(/32 octets/);
    expect(parse(`k2:${K1}`)).toThrow(/clé active/);
    expect(parse(`k1:${K1},k1:${K1}`)).toThrow(/en double/);
    expect(() => loadEnv({ ...base, SECRETS_ENCRYPTION_PREVIOUS_KEYS: `k1:${K1}` })).toThrow(/clé active/);
    try {
      parse('k1:AAAA')();
    } catch (error) {
      expect((error as Error).message).not.toContain('AAAA');
    }
  });
});
