import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { APP_ENV, type AppEnv } from './env.js';
import { BusinessRuleError } from '../common/errors.js';

export interface EncryptedSecret {
  keyId: string;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * Chiffrement au repos des secrets fournisseur (CDC 14.6) : AES-256-GCM, clé hors base
 * (SECRETS_ENCRYPTION_KEY), identifiant de clé stocké pour la rotation.
 */
@Injectable()
export class SecretsCryptoService {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  isConfigured(): boolean {
    return this.env.secretsEncryptionKey !== null;
  }

  encrypt(plain: string): EncryptedSecret {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return { keyId: this.env.secretsEncryptionKeyId, iv, authTag: cipher.getAuthTag(), ciphertext };
  }

  decrypt(secret: EncryptedSecret): string {
    const key = this.requireKey();
    if (secret.keyId !== this.env.secretsEncryptionKeyId) {
      throw new BusinessRuleError(
        'CLE_SECRET_INCONNUE',
        'Ce secret a été chiffré avec une autre clé ; suivez la procédure de rotation documentée.',
      );
    }
    const decipher = createDecipheriv('aes-256-gcm', key, secret.iv);
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
  }

  private requireKey(): Buffer {
    if (!this.env.secretsEncryptionKey) {
      throw new BusinessRuleError(
        'CHIFFREMENT_NON_CONFIGURE',
        'SECRETS_ENCRYPTION_KEY n’est pas configurée : impossible de stocker un secret fournisseur.',
      );
    }
    return this.env.secretsEncryptionKey;
  }
}
