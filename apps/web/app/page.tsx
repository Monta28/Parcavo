import { redirect } from 'next/navigation';
import { getSession } from '@/lib/api-server';

export default async function IndexPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  redirect(session.isDriverOnly && session.driverId ? `/conducteurs/${session.driverId}` : '/tableau-de-bord');
}
