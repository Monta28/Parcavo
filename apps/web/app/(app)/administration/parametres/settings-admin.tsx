'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import { groupSettings, matchesSearch, type EffectiveSetting } from '@/lib/settings-admin';
import { useListParams } from '@/lib/use-list-params';
import { ClearOverrideDialog, SettingEditDialog, SettingHistoryDialog } from './setting-dialogs';
import { SettingsTable } from './settings-table';

const GROUP = 'groupe';

type Action = { kind: 'edit' | 'history' | 'clear'; setting: EffectiveSetting } | null;

/**
 * Paramètres de l'organisation (CDC 17.1 ; administrateur) : valeur groupe et surcharges explicites par
 * société, chacune versionnée, motivée et journalisée par l'API (PUT /settings/:key, DELETE
 * /settings/:key/override). Niveau affiché et recherche conservés dans l'URL.
 */
export function SettingsAdmin() {
  const { session } = useAppScope();
  const { get, set } = useListParams();
  const company = session.companies.find((c) => c.id === get('societe')) ?? null;
  const companyId = company?.id ?? null;
  const companyLabel = company ? `${company.code} — ${company.name}` : null;
  const q = get('q');
  const [action, setAction] = useState<Action>(null);

  const settings = useQuery({
    queryKey: ['settings', 'effective', companyId],
    queryFn: () => api<EffectiveSetting[]>(`/settings${toQuery({ companyId })}`),
  });
  const groups = useMemo(() => groupSettings((settings.data ?? []).filter((s) => matchesSearch(s, q))), [settings.data, q]);
  const close = (open: boolean) => {
    if (!open) setAction(null);
  };

  return (
    <div>
      <PageHeader
        title="Paramètres"
        description="Valeurs initiales du cahier des charges (17.1), valeur groupe et surcharges explicites par société. Chaque modification crée une version, exige un motif et est journalisée ; la validation est faite par le serveur."
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="settings-level" className="text-xs text-muted-foreground">
            Niveau affiché
          </Label>
          <Select value={companyId ?? GROUP} onValueChange={(v) => set({ societe: v === GROUP ? '' : v })}>
            <SelectTrigger id="settings-level" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GROUP}>Groupe (valeur par défaut des sociétés)</SelectItem>
              {session.companies.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="settings-q" className="text-xs text-muted-foreground">
            Recherche
          </Label>
          <Input id="settings-q" placeholder="Libellé ou clé du paramètre" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        </div>
      </div>

      {settings.isPending ? (
        <LoadingState label="Chargement des paramètres…" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} retry={() => void settings.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState title="Aucun paramètre" description={q ? 'Aucun paramètre ne correspond à la recherche.' : 'L’API n’a renvoyé aucun paramètre.'} />
      ) : (
        <SettingsTable
          groups={groups}
          companyId={companyId}
          companyLabel={companyLabel}
          onEdit={(setting) => setAction({ kind: 'edit', setting })}
          onHistory={(setting) => setAction({ kind: 'history', setting })}
          onClearOverride={(setting) => setAction({ kind: 'clear', setting })}
        />
      )}

      {action?.kind === 'edit' ? <SettingEditDialog key={action.setting.key} setting={action.setting} companyId={companyId} companyLabel={companyLabel} onOpenChange={close} /> : null}
      {action?.kind === 'history' ? <SettingHistoryDialog setting={action.setting} companyId={companyId} companyLabel={companyLabel} onOpenChange={close} /> : null}
      {action?.kind === 'clear' && companyId ? <ClearOverrideDialog setting={action.setting} companyId={companyId} companyLabel={companyLabel} onOpenChange={close} /> : null}
    </div>
  );
}
