'use client';

import { BellRing, LogOut, Menu } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { api } from '@/lib/api-client';
import { CompanySelector } from './company-selector';
import { MainNav } from './nav';
import { useSession } from './session-context';

export function AppShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="no-print hidden w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4 md:flex">
        <div className="mb-6 px-3">
          <div className="text-lg font-semibold">Parc Auto</div>
          <div className="truncate text-xs text-muted-foreground">{session.organizationName}</div>
        </div>
        <MainNav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Ouvrir le menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 px-3 py-6">
              <SheetTitle className="mb-4 px-3">Parc Auto</SheetTitle>
              <MainNav onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="flex-1">{session.isDriverOnly ? null : <CompanySelector />}</div>
          <div className="hidden text-sm sm:block">
            <span className="font-medium">
              {session.firstName} {session.lastName}
            </span>
            <span className="ml-2 text-muted-foreground">{session.isAdmin ? 'Administrateur' : session.isDriverOnly ? 'Conducteur' : ''}</span>
          </div>
          {session.isDriverOnly ? null : (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/profil/notifications" aria-label="Mes notifications" title="Mes notifications">
                <BellRing className="size-4" aria-hidden="true" />
                <span className="hidden lg:inline">Mes notifications</span>
              </Link>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={logout} aria-label="Se déconnecter">
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Déconnexion</span>
          </Button>
        </header>
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
