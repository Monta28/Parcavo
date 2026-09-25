import { Injectable } from '@nestjs/common';
import type { Prisma } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import type { CompanyGrant, RequestContext } from '../../common/request-context.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { effectivePermissions } from '../access-control/permissions.js';
import { hashToken } from './session.service.js';

const LAST_SEEN_REFRESH_MS = 60_000;

type ContextUser = Prisma.UserGetPayload<{ include: { memberships: { include: { company: { select: { id: true; status: true } } } }; driver: { select: { id: true } } } }>;

/**
 * Construit le RequestContext à partir du jeton de session (CDC 2.3, 16.1). Une session révoquée,
 * expirée ou un compte désactivé donnent null : la requête est rejetée en 401.
 */
@Injectable()
export class ContextBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async fromSessionToken(sessionToken: string, requestId: string, ipAddress: string | null): Promise<RequestContext | null> {
    return (await this.resolveSession(sessionToken, requestId, ipAddress))?.context ?? null;
  }

  /**
   * Contexte et empreinte du jeton CSRF de la session, lus ensemble : la garde CSRF de la même requête la
   * compare sans relire la session (CsrfGuard).
   */
  async resolveSession(sessionToken: string, requestId: string, ipAddress: string | null): Promise<{ context: RequestContext; csrfTokenHash: string } | null> {
    const now = this.clock.now();
    const session = await this.prisma.client.session.findUnique({
      where: { tokenHash: hashToken(sessionToken) },
      include: {
        user: {
          include: { memberships: { include: { company: { select: { id: true, status: true } } } }, driver: { select: { id: true } } },
        },
      },
    });
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    if (session.user.status !== 'ACTIF') return null;

    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.prisma.client.session.update({ where: { id: session.id }, data: { lastSeenAt: now } }).catch(() => undefined);
    }
    return { context: await this.build(session.user, session.id, requestId, ipAddress), csrfTokenHash: session.csrfTokenHash };
  }

  /**
   * Contexte d'un utilisateur hors requête HTTP (traitement différé exécuté pour son compte, 2.3) :
   * habilitations relues à l'exécution ; null si le compte est inconnu ou désactivé.
   */
  async forUser(userId: string, organizationId: string, requestId: string): Promise<RequestContext | null> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, organizationId },
      include: { memberships: { include: { company: { select: { id: true, status: true } } } }, driver: { select: { id: true } } },
    });
    if (!user || user.status !== 'ACTIF') return null;
    return this.build(user, '', requestId, null);
  }

  private async build(user: ContextUser, sessionId: string, requestId: string, ipAddress: string | null): Promise<RequestContext> {
    const grants = new Map<string, CompanyGrant>();
    let isAdmin = false;
    for (const m of user.memberships) {
      if (m.companyId === null) {
        if (m.role === 'ADMIN') isAdmin = true;
        continue;
      }
      if (m.company && m.company.status !== 'ACTIF') continue;
      grants.set(m.companyId, {
        companyId: m.companyId,
        role: m.role,
        permissions: effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions),
      });
    }

    const isDriverOnly = !isAdmin && [...grants.values()].every((g) => g.role === 'CONDUCTEUR');

    // Périmètre de lecture de gestion (CDC 2.3) : une habilitation CONDUCTEUR ne donne jamais accès aux
    // données de gestion de sa société. Pour un compte mixte (gestionnaire dans A, conducteur dans B), seule
    // A est lisible ; un compte uniquement conducteur garde ses sociétés, filtrées ensuite par ses règles propres.
    let visibleCompanyIds: string[];
    if (isAdmin) {
      const companies = await this.prisma.client.company.findMany({
        where: { organizationId: user.organizationId },
        select: { id: true },
      });
      visibleCompanyIds = companies.map((c) => c.id);
    } else if (isDriverOnly) {
      visibleCompanyIds = [...grants.keys()];
    } else {
      visibleCompanyIds = [...grants.values()].filter((g) => g.role !== 'CONDUCTEUR').map((g) => g.companyId);
    }

    return {
      requestId,
      userId: user.id,
      organizationId: user.organizationId,
      sessionId,
      email: user.email,
      displayName: `${user.firstName} ${user.lastName}`.trim(),
      isAdmin,
      grants,
      driverId: user.driver?.id ?? null,
      visibleCompanyIds,
      isDriverOnly,
      ipAddress,
    };
  }
}
