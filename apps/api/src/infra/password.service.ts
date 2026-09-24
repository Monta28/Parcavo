import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** Hachage Argon2id (CDC 16.1). Paramètres : 64 Mio, 3 itérations, parallélisme 1. */
// algorithm 2 = Argon2id (énumération constante de @node-rs/argon2, non importable avec isolatedModules).
const OPTIONS = { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    return hash(plain, OPTIONS);
  }

  async verify(hashed: string | null | undefined, plain: string): Promise<boolean> {
    if (!hashed) {
      // Hachage factice pour garder un temps de réponse constant (message non énumérant).
      await hash(plain, OPTIONS);
      return false;
    }
    try {
      return await verify(hashed, plain, OPTIONS);
    } catch {
      return false;
    }
  }

  /** Règles minimales de robustesse ; message en français. */
  validateStrength(plain: string): string | null {
    if (plain.length < PASSWORD_MIN_LENGTH) return `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`;
    if (!/[a-z]/.test(plain) || !/[A-Z]/.test(plain) || !/[0-9]/.test(plain)) {
      return 'Le mot de passe doit contenir des minuscules, des majuscules et des chiffres.';
    }
    return null;
  }
}
