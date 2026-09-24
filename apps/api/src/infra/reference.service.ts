import { Injectable } from '@nestjs/common';
import type { Tx } from './prisma.service.js';

/**
 * Références métier lisibles, uniques et immuables (D-203) : <PORTEE>-<AAAA>-<NNNNNN>, séquence par
 * organisation, portée et année. Le compteur est incrémenté par INSERT … ON CONFLICT DO UPDATE : la
 * ligne reste verrouillée jusqu'à la fin de la transaction appelante, ce qui sérialise les attributions.
 */
@Injectable()
export class ReferenceService {
  async next(tx: Tx, organizationId: string, scope: 'INT' | 'INC', year: number): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ lastValue: number }>>`
      INSERT INTO "ReferenceSequence" ("organizationId", "scope", "year", "lastValue")
      VALUES (${organizationId}::uuid, ${scope}, ${year}, 1)
      ON CONFLICT ("organizationId", "scope", "year") DO UPDATE SET "lastValue" = "ReferenceSequence"."lastValue" + 1
      RETURNING "lastValue"`;
    const value = rows[0]?.lastValue;
    if (value === undefined) throw new Error('Séquence de référence indisponible');
    return `${scope}-${year}-${String(value).padStart(6, '0')}`;
  }
}
