import { describe, expect, it } from 'vitest';
import { Prisma } from '@parc-auto/db';
import { isRetryable } from './prisma.service.js';

const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError('échec', { code, clientVersion: 'test', meta });

describe('Reprise des transactions sérialisables (CDC 13.3)', () => {
  it('reprend P2034 et les conflits 40001/40P01 d’une requête brute (P2010), pas les autres erreurs', () => {
    expect(isRetryable(known('P2034'))).toBe(true);
    expect(isRetryable(known('P2010', { driverAdapterError: { cause: { kind: 'TransactionWriteConflict', originalCode: '40001' } } }))).toBe(true);
    expect(isRetryable(known('P2010', { driverAdapterError: { cause: { originalCode: '40P01' } } }))).toBe(true);
    expect(isRetryable(known('P2010', { driverAdapterError: { cause: { originalCode: '23505' } } }))).toBe(false);
    expect(isRetryable(known('P2002'))).toBe(false);
    expect(isRetryable(new Error('autre'))).toBe(false);
  });
});
