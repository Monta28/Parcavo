'use client';

import { PageHeader } from '@/components/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useListParams } from '@/lib/use-list-params';
import { CalendarTab } from './calendar-tab';
import { CatalogTab } from './catalog-tab';
import { PlanDetailSheet } from './plan-detail-sheet';
import { PlansTab } from './plans-tab';
import { TemplatesTab } from './templates-tab';

const TABS = ['echeances', 'calendrier', 'catalogue', 'modeles'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tab = (typeof TABS)[number];

/** /entretiens (CDC 6.1, 6.2, 10.2) : échéances des plans, calendrier du mois, catalogue des opérations et modèles copiables. */
export function MaintenanceView() {
  const { get, set, page } = useListParams();
  const raw = get('onglet');
  const tab: Tab = (TABS as readonly string[]).includes(raw) ? (raw as Tab) : 'echeances';
  // ?plan=<id> : lien direct des alertes d'échéance et de la fiche véhicule ; une valeur non valide est ignorée.
  const rawPlanId = get('plan');
  const planId = UUID.test(rawPlanId) ? rawPlanId : '';

  return (
    <div>
      <PageHeader title="Entretiens" description="Plans d’entretien préventif par véhicule, échéances en km et en date, calendrier des échéances et interventions planifiées, catalogue des opérations et modèles de plans." />
      <Tabs value={tab} onValueChange={(v) => set({ onglet: v === 'echeances' ? '' : v, ...(v === 'calendrier' ? {} : { mois: '' }) })}>
        <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
          <TabsTrigger value="echeances">Échéances</TabsTrigger>
          <TabsTrigger value="calendrier">Calendrier</TabsTrigger>
          <TabsTrigger value="catalogue">Catalogue</TabsTrigger>
          <TabsTrigger value="modeles">Modèles</TabsTrigger>
        </TabsList>
        <TabsContent value="echeances">
          <PlansTab />
        </TabsContent>
        <TabsContent value="calendrier">
          <CalendarTab />
        </TabsContent>
        <TabsContent value="catalogue">
          <CatalogTab />
        </TabsContent>
        <TabsContent value="modeles">
          <TemplatesTab />
        </TabsContent>
      </Tabs>
      {planId ? <PlanDetailSheet key={planId} planId={planId} onClose={() => set({ plan: '', page: page > 1 ? page : null })} /> : null}
    </div>
  );
}
