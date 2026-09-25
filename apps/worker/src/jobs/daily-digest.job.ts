import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService, PrismaService, describeErrorSafely, localDate } from '@parc-auto/api';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';

export const DAILY_DIGEST_TASK = 'recapitulatif-quotidien';

/**
 * Récapitulatif quotidien (CDC 9.4, 17.1 ; D-262, D-263) — chaque minute, pour chaque organisation, à sa
 * date locale (fuseau du groupe, Africa/Tunis) : NotificationsService.buildDailyDigest met en file un
 * récapitulatif par destinataire dès email.dailyDigestLocalTime (08:00). Un worker arrêté à 08:00
 * rattrape le jour même à son redémarrage ; la clé digest:utilisateur:date empêche tout second envoi ;
 * rien n'est mis en file sans SMTP, avant l'heure, ni pour un récapitulatif vide.
 */
@Injectable()
export class DailyDigestJob implements ScheduledTask {
  readonly name = DAILY_DIGEST_TASK;
  readonly periodMs = 60_000;
  readonly leaseMs = 2 * 60_000;
  private readonly logger = new Logger(DailyDigestJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async run(now: Date): Promise<TaskSummary> {
    const organizations = await this.prisma.client.organization.findMany({ select: { id: true, timezone: true }, orderBy: { createdAt: 'asc' } });
    const summary = { organisations: organizations.length, crees: 0, dejaEnFile: 0, vides: 0, desactives: 0 };
    const outcomes: Record<string, number> = {};
    const errors: string[] = [];
    for (const org of organizations) {
      // Chaque organisation est isolée : l'échec de l'une n'empêche pas le récapitulatif des autres.
      try {
        const result = await this.notifications.buildDailyDigest(org.id, localDate(now, org.timezone));
        summary.crees += result.created;
        summary.dejaEnFile += result.alreadyQueued;
        summary.vides += result.empty;
        summary.desactives += result.optedOut;
        outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      } catch (error) {
        const message = describeErrorSafely(error);
        this.logger.error(`Récapitulatif de l’organisation ${org.id} en échec : ${message}`);
        errors.push(`${org.id} : ${message}`);
      }
    }
    // Jamais de succès prétendu : une organisation en échec rend l'exécution en échec (reprise à la minute suivante).
    if (errors.length > 0) throw new Error(`Récapitulatif en échec pour ${errors.length} organisation(s) sur ${organizations.length} (${summary.crees} créé(s) pour les autres) : ${errors.join(' ; ')}`);
    return { ...summary, ...Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [`issue_${k}`, v])) };
  }
}
