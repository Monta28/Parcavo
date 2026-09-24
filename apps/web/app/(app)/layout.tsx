import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { SessionProvider } from '@/components/layout/session-context';
import { getSession } from '@/lib/api-server';
import { COMPANY_COOKIE, resolveCompanyScope } from '@/lib/company-scope';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login?expire=1');
  const jar = await cookies();
  const scope = resolveCompanyScope(session, jar.get(COMPANY_COOKIE)?.value);
  return (
    <SessionProvider value={{ session, companyId: scope.companyId, canSeeAll: scope.canSeeAll }}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
