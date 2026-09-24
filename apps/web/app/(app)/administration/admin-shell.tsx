'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { ApiRequestError } from '@/lib/api-error';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { href: '/administration', label: 'Sociétés', exact: true },
  { href: '/administration/sites', label: 'Sites et services' },
  { href: '/administration/categories', label: 'Catégories de véhicules' },
  { href: '/administration/utilisateurs', label: 'Utilisateurs' },
  { href: '/administration/organisation', label: 'Organisation' },
] as const;

const FORBIDDEN = new ApiRequestError(403, { code: 'ADMIN_REQUIS', message: 'La section Administration est réservée à l’administrateur groupe.' });

/** Garde et sous-navigation de l'administration (CDC 2.1, 2.2, 10.2) : réservée à l'administrateur groupe. */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const { session } = useAppScope();
  const pathname = usePathname();

  if (!session.isAdmin) {
    return (
      <div>
        <PageHeader title="Administration" />
        <ErrorState error={FORBIDDEN} />
      </div>
    );
  }

  return (
    <div>
      <nav aria-label="Sections de l’administration" className="mb-6 border-b">
        <ul className="-mb-px flex flex-wrap gap-x-1">
          {SECTIONS.map((section) => {
            const active = 'exact' in section && section.exact ? pathname === section.href : pathname === section.href || pathname.startsWith(`${section.href}/`);
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
      {children}
    </div>
  );
}
