'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Calendar, Car, ClipboardList, Gauge, LayoutDashboard, Settings, Smartphone, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCan, useSession } from './session-context';

type Audience = 'staff' | 'manager' | 'costs' | 'admin';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Qui voit l'entrée ; l'API reste seule juge des droits (le menu masque seulement l'inaccessible). */
  audience: Audience;
}

const STAFF_ITEMS: NavItem[] = [
  { href: '/tableau-de-bord', label: 'Tableau de bord', icon: LayoutDashboard, audience: 'staff' },
  { href: '/vehicules', label: 'Véhicules', icon: Car, audience: 'staff' },
  { href: '/conducteurs', label: 'Conducteurs', icon: Users, audience: 'staff' },
  { href: '/planning', label: 'Planning', icon: Calendar, audience: 'staff' },
  { href: '/utilisations', label: 'Utilisations', icon: ClipboardList, audience: 'staff' },
  { href: '/kilometrage', label: 'Kilométrage', icon: Gauge, audience: 'staff' },
  { href: '/administration', label: 'Administration', icon: Settings, audience: 'admin' },
];

const DRIVER_ITEMS: NavItem[] = [{ href: '/mon-vehicule', label: 'Mon véhicule', icon: Smartphone, audience: 'staff' }];

export function MainNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const session = useSession();
  const canReadCosts = useCan('costs.read');
  const isManager = session.isAdmin || session.grants.some((g) => g.role === 'CHEF_PARC');
  const visible = (audience: Audience): boolean => audience === 'staff' || (audience === 'costs' && canReadCosts) || (audience === 'manager' && isManager) || (audience === 'admin' && session.isAdmin);
  const items = (session.isDriverOnly ? DRIVER_ITEMS : STAFF_ITEMS).filter((i) => visible(i.audience));
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
