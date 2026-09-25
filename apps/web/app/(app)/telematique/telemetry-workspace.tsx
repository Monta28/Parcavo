'use client';

import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useListParams } from '@/lib/use-list-params';
import { AssociationsTab } from './associations-tab';
import { FuelEventsTab } from './fuel-events-tab';
import { SyncTab } from './sync-tab';

type TabKey = 'associations' | 'synchronisation' | 'carburant';
const TABS: readonly TabKey[] = ['associations', 'synchronisation', 'carburant'];

/**
 * Télématique pour le chef de parc et l'administrateur (CDC 5.6, 8.5, 14.4 à 14.6 ; D-112) :
 * associations des boîtiers, état de synchronisation des sociétés du périmètre et événements carburant
 * à qualifier. Opérateur et lecteur consultent ; le conducteur n'a aucun accès. Aucun suivi en direct :
 * seules les données reçues du fournisseur et leur traitement sont affichés.
 */
export function TelemetryWorkspace() {
  const { session } = useAppScope();
  const { get, set } = useListParams();
  if (session.isDriverOnly) {
    return (
      <div>
        <PageHeader title="Télématique" />
        <EmptyState title="Écran réservé au personnel du parc" description="La télématique est gérée par le chef de parc et l’administrateur." />
      </div>
    );
  }
  const requested = get('onglet') as TabKey;
  const tab: TabKey = TABS.includes(requested) ? requested : 'associations';
  return (
    <div>
      <PageHeader
        title="Télématique"
        description="Associations des boîtiers aux véhicules, état de synchronisation et événements carburant à qualifier. Aucun suivi en direct : seules les données reçues et leur traitement sont affichés ; le kilométrage manuel reste toujours possible."
      />
      <Tabs value={tab} onValueChange={(v) => set({ onglet: v, categorie: '', q: '', fournisseur: '', statut: '', type: '', evenement: '', vehicule: '' })}>
        <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
          <TabsTrigger value="associations">Associations</TabsTrigger>
          <TabsTrigger value="synchronisation">Synchronisation</TabsTrigger>
          <TabsTrigger value="carburant">Événements carburant</TabsTrigger>
        </TabsList>
        <TabsContent value="associations">{tab === 'associations' ? <AssociationsTab /> : null}</TabsContent>
        <TabsContent value="synchronisation">{tab === 'synchronisation' ? <SyncTab /> : null}</TabsContent>
        <TabsContent value="carburant">{tab === 'carburant' ? <FuelEventsTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
