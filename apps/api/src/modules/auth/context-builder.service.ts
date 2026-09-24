import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock.js';
import type { CompanyGrant, RequestContext } from '../../common/request-context.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { effectivePermissions } from '../access-control/permissions.js';
import { hashToken } from './session.service.js';

const LAST_SEEN_REFRESH_MS = 60_000;

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

    const grants = new Map<string, CompanyGrant>();
    let isAdmin = false;
    for (const m of session.user.memberships) {
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

    let visibleCompanyIds: string[];
    if (isAdmin) {
      const companies = await this.prisma.client.company.findMany({
        where: { organizationId: session.user.organizationId },
        select: { id: true },
      });
      visibleCompanyIds = companies.map((c) => c.id);
    } else {
      visibleCompanyIds = [...grants.keys()];
    }

    const isDriverOnly = !isAdmin && [...grants.values()].every((g) => g.role === 'CONDUCTEUR');

    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.prisma.client.session.update({ where: { id: session.id }, data: { lastSeenAt: now } }).catch(() => undefined);
    }

    return {
      requestId,
      userId: session.user.id,
      organizationId: session.user.organizationId,
      sessionId: session.id,
      email: session.user.email,
      displayName: `${session.user.firstName} ${session.user.lastName}`.trim(),
      isAdmin,
      grants,
      driverId: session.user.driver?.id ?? null,
      visibleCompanyIds,
      isDriverOnly,
      ipAddress,
    };
  }
}
