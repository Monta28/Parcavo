'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { ApiRequestError } from '@/lib/api-error';
import { cn } from '@/lib/utils';

const AUDIT_HREF = '/administration/audit';

const SECTIONS = [
  { href: '/administration', label: 'Sociétés', exact: true },
  { href: '/administration/sites', label: 'Sites et services' },
  { href: '/administration/categories', label: 'Catégories de véhicules' },
  { href: '/administration/utilisateurs', label: 'Utilisateurs' },
  { href: '/administration/organisation', label: 'Organisation' },
  { href: '/administration/parametres', label: 'Paramètres' },
  { href: '/administration/notifications', label: 'Notifications' },
  { href: AUDIT_HREF, label: 'Audit' },
] as const;

type Section = (typeof SECTIONS)[number];

const FORBIDDEN = new ApiRequestError(403, { code: 'ADMIN_REQUIS', message: 'La section Administration est réservée à l’administrateur groupe.' });
const FORBIDDEN_FOR_MANAGER = new ApiRequestError(403, {
  code: 'ADMIN_REQUIS',
  message: 'Cette rubrique est réservée à l’administrateur groupe. En tant que chef de parc, vous consultez uniquement le journal d’audit de vos sociétés.',
});

function isActive(section: Section, pathname: string): boolean {
  return 'exact' in section && section.exact ? pathname === section.href : pathname === section.href || pathname.startsWith(`${section.href}/`);
}

/**
 * Garde et sous-navigation de l'administration (CDC 2.1, 2.2, 10.2 ; D-109) : réservée à l'administrateur
 * groupe, sauf l'onglet Audit, ouvert aussi au chef de parc (seul onglet qu'il voit). Ce masquage n'est
 * qu'un confort de navigation : GET /audit applique le périmètre et renvoie 403 aux autres rôles, dont la
 * réponse est affichée telle quelle par la page.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const { session } = useAppScope();
  const pathname = usePathname();
  const onAudit = pathname === AUDIT_HREF || pathname.startsWith(`${AUDIT_HREF}/`);
  const isFleetManager = !session.isAdmin && !session.isDriverOnly && session.grants.some((g) => g.role === 'CHEF_PARC');
  const sections: readonly Section[] = session.isAdmin ? SECTIONS : isFleetManager ? SECTIONS.filter((s) => s.href === AUDIT_HREF) : [];

  // Hors de l'onglet Audit, tout rôle autre qu'administrateur reçoit l'accès refusé sans appel inutile.
  if (!session.isAdmin && !onAudit) {
    return (
      <div>
        {sections.length > 0 ? <SectionsNav sections={sections} pathname={pathname} /> : null}
        <PageHeader title="Administration" />
        <ErrorState error={isFleetManager ? FORBIDDEN_FOR_MANAGER : FORBIDDEN} />
        {isFleetManager ? (
          <p className="mt-4 text-center text-sm">
            <Link href={AUDIT_HREF} className="underline underline-offset-4">
              Ouvrir le journal d’audit
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {sections.length > 0 ? <SectionsNav sections={sections} pathname={pathname} /> : null}
      {children}
    </div>
  );
}

function SectionsNav({ sections, pathname }: { sections: readonly Section[]; pathname: string }) {
  return (
    <nav aria-label="Sections de l’administration" className="mb-6 border-b">
      <ul className="-mb-px flex flex-wrap gap-x-1">
        {sections.map((section) => {
          const active = isActive(section, pathname);
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
