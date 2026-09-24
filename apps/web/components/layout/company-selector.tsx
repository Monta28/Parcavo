'use client';

import { useRouter } from 'next/navigation';
import { ALL_COMPANIES, COMPANY_COOKIE } from '@/lib/company-scope';
import { useAppScope } from './session-context';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function CompanySelector() {
  const { session, companyId, canSeeAll } = useAppScope();
  const router = useRouter();
  if (session.companies.length <= 1 && !session.isAdmin) {
    const only = session.companies[0];
    return <span className="text-sm text-muted-foreground">{only ? `${only.code} · ${only.name}` : 'Aucune société'}</span>;
  }
  const value = companyId ?? ALL_COMPANIES;
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        document.cookie = `${COMPANY_COOKIE}=${encodeURIComponent(next)}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
    >
      <SelectTrigger className="w-[220px]" aria-label="Société courante">
        <SelectValue placeholder="Société" />
      </SelectTrigger>
      <SelectContent>
        {canSeeAll ? <SelectItem value={ALL_COMPANIES}>Toutes mes sociétés</SelectItem> : null}
        {session.companies.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.code} · {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
