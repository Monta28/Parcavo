'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useAppScope } from '@/components/layout/session-context';
import { useScopeChecks } from '@/components/odometer/reading-helpers';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { ReadingView } from '@/lib/odometer-types';
import { useListParams } from '@/lib/use-list-params';
import { PendingReadings } from './pending-readings';
import { QuickEntry, useQuickEntryState } from './quick-entry';
import { ReadingsHistory } from './readings-history';

type TabKey = 'saisie' | 'a-valider' | 'historique';
const TABS: readonly TabKey[] = ['saisie', 'a-valider', 'historique'];

/** Kilométrage (CDC 5.1 à 5.5, 10.2) : saisie rapide par parc, file de validation et historique. */
export function OdometerWorkspace() {
  const { session } = useAppScope();
  if (session.isDriverOnly) {
    return (
      <div>
        <PageHeader title="Kilométrage" />
        <EmptyState
          title="Écran réservé au personnel du parc"
          description="Déclarez le kilométrage de votre véhicule depuis l’espace « Mon véhicule »."
          action={
            <Button asChild variant="outline">
              <Link href="/mon-vehicule">Mon véhicule</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return <StaffOdometerWorkspace />;
}

function StaffOdometerWorkspace() {
  const { companyId, session } = useAppScope();
  const { operational } = useScopeChecks();
  const { get, set } = useListParams();
  const canEnter = operational(companyId);
  const quickEntry = useQuickEntryState(session.timezone);

  const requested = get('onglet') as TabKey;
  // Le lien des alertes « relevé à valider » ouvre la file (statut=EN_ATTENTE&vehicule=…).
  const fallback: TabKey = get('statut') === 'EN_ATTENTE' ? 'a-valider' : canEnter ? 'saisie' : 'historique';
  const tab: TabKey = TABS.includes(requested) && (requested !== 'saisie' || canEnter) ? requested : fallback;

  const pendingQuery = toQuery({ companyId, status: 'EN_ATTENTE', pageSize: 1 });
  const pending = useQuery({ queryKey: ['readings', pendingQuery], queryFn: () => api<Page<ReadingView>>(`/readings${pendingQuery}`), select: (p) => p.total });

  return (
    <div>
      <PageHeader title="Kilométrage" description="Relevés de compteur : saisie rapide par parc, anomalies à valider et historique. Seuls les relevés acceptés participent aux calculs." />
      <Tabs value={tab} onValueChange={(v) => set({ onglet: v })}>
        <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
          {canEnter ? <TabsTrigger value="saisie">Saisie rapide</TabsTrigger> : null}
          <TabsTrigger value="a-valider">
            À valider
            {pending.data !== undefined && pending.data > 0 ? (
              <span className="ml-1 rounded-full bg-warning/20 px-2 text-xs font-semibold text-warning-foreground">
                {pending.data}
                <span className="sr-only"> relevé(s) en attente</span>
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="historique">Historique</TabsTrigger>
        </TabsList>
        {canEnter ? (
          <TabsContent value="saisie">
            <QuickEntry state={quickEntry} />
          </TabsContent>
        ) : null}
        <TabsContent value="a-valider">
          <PendingReadings />
        </TabsContent>
        <TabsContent value="historique">
          <ReadingsHistory />
        </TabsContent>
      </Tabs>
    </div>
  );
}
