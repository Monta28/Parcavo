import { ROLE_LABELS } from '@parc-auto/contracts';
import type { MembershipView } from '@/lib/admin-types';

export function membershipLabel(m: MembershipView): string {
  return m.companyId ? `${m.companyCode ?? ''} · ${ROLE_LABELS[m.role]}` : ROLE_LABELS[m.role];
}

/** Liste compacte des habilitations d'un compte (rôle par société ou niveau groupe). */
export function MembershipSummary({ memberships }: { memberships: MembershipView[] }) {
  if (memberships.length === 0) return <span className="text-muted-foreground">Aucune</span>;
  return (
    <ul className="space-y-0.5">
      {memberships.map((m) => (
        <li key={m.id}>{membershipLabel(m)}</li>
      ))}
    </ul>
  );
}
