'use client';

import { createContext, useContext } from 'react';
import type { SessionInfo } from '@/lib/api-types';

export interface AppScope {
  session: SessionInfo;
  companyId: string | null;
  canSeeAll: boolean;
}

const SessionContext = createContext<AppScope | null>(null);

export function SessionProvider({ value, children }: { value: AppScope; children: React.ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useAppScope(): AppScope {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useAppScope doit être utilisé sous SessionProvider.');
  return ctx;
}

export function useSession(): SessionInfo {
  return useAppScope().session;
}

/** Vérifie une permission sur la société courante (ou sur au moins une société si « toutes »). */
export function useCan(permission: string): boolean {
  const { session, companyId } = useAppScope();
  if (session.isAdmin) return true;
  if (companyId) return session.grants.some((g) => g.companyId === companyId && g.permissions.includes(permission));
  return session.grants.some((g) => g.permissions.includes(permission));
}

export function useRoleIn(companyId: string | null): string | null {
  const { session } = useAppScope();
  if (session.isAdmin) return 'ADMIN';
  if (!companyId) return null;
  return session.grants.find((g) => g.companyId === companyId)?.role ?? null;
}
