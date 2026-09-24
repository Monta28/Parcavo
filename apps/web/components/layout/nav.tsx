'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Car, LayoutDashboard, Settings, Smartphone, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSession } from './session-context';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

const STAFF_ITEMS: NavItem[] = [
  { href: '/tableau-de-bord', label: 'Tableau de bord', icon: LayoutDashboard },
  { href: '/vehicules', label: 'Véhicules', icon: Car },
  { href: '/conducteurs', label: 'Conducteurs', icon: Users },
  { href: '/administration', label: 'Administration', icon: Settings, adminOnly: true },
];

export function MainNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const session = useSession();
  // Compte conducteur : sa fiche seulement (les utilisations et Mon véhicule arrivent avec le lot B).
  const driverItems: NavItem[] = session.driverId ? [{ href: `/conducteurs/${session.driverId}`, label: 'Ma fiche conducteur', icon: Smartphone }] : [];
  const items = (session.isDriverOnly ? driverItems : STAFF_ITEMS).filter((i) => !i.adminOnly || session.isAdmin);
  return (
    <nav aria-label="Navigation principale" className="flex flex-col gap-1">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/80',
            )}
          >
            <item.icon className="size-4" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
