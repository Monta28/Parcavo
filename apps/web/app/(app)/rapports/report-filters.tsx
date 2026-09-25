'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { DriverIdFilter, VehicleIdFilter } from '@/components/documents/owner-pickers';
import { SupplierIdFilter } from '@/components/reports/supplier-id-filter';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { DocumentTypeView } from '@/lib/documents-types';
import type { MaintenanceTypeView } from '@/lib/maintenance-types';
import type { ReportFilterKey, ReportViewDefinition } from '@/lib/reports-types';
import type { SiteView, VehicleCategory } from '@/lib/vehicles-types';

const ALL = '__all__';

/** Libellés des champs de filtre (les filtres proposés sont ceux que l'API déclare pour la vue). */
export const FILTER_FIELD_LABELS: Record<ReportFilterKey, string> = {
  companyId: 'Société',
  siteId: 'Site',
  vehicleId: 'Véhicule',
  driverId: 'Conducteur',
  categoryId: 'Catégorie de véhicule',
  supplierId: 'Fournisseur',
  maintenanceTypeId: 'Type d’opération',
  documentTypeId: 'Type de document',
  from: 'Du',
  to: 'Au',
  q: 'Recherche',
  vue: 'Vue',
  status: 'Statut',
  lifecycleStatus: 'Cycle de vie',
  operationalStatus: 'État opérationnel',
  distanceStatus: 'Statut de la distance',
  lateOnly: 'Retards uniquement',
  source: 'Source du relevé',
  freshness: 'Fraîcheur du kilométrage',
  ownerType: 'Objet',
  blocking: 'Bloquants uniquement',
  energy: 'Carburant',
  category: 'Catégorie de dépense',
  incidentType: 'Type d’incident',
  severity: 'Gravité',
};

/** Ordre d'affichage des champs : période, recherche, objets, statuts, interrupteurs. */
const FIELD_ORDER: readonly ReportFilterKey[] = [
  'from',
  'to',
  'q',
  'siteId',
  'vehicleId',
  'driverId',
  'categoryId',
  'supplierId',
  'maintenanceTypeId',
  'documentTypeId',
  'status',
  'lifecycleStatus',
  'operationalStatus',
  'distanceStatus',
  'source',
  'freshness',
  'ownerType',
  'energy',
  'category',
  'incidentType',
  'severity',
  'lateOnly',
  'blocking',
];

export interface ReportFiltersProps {
  view: ReportViewDefinition;
  /** Valeur d'un filtre dans l'URL ('' si absent). */
  value: (key: ReportFilterKey) => string;
  onChange: (updates: Partial<Record<ReportFilterKey, string>>) => void;
  /** Société courante (sélecteur de l'en-tête) : restreint les listes de choix. */
  companyId: string | null;
  /** Période résolue par l'API pour la dernière page reçue (affichée quand l'URL n'en fixe pas). */
  period: { from: string; to: string } | null;
  /** Valeurs admises des filtres à choix fermé et leurs libellés (catalogue GET /reports). */
  options: Partial<Record<ReportFilterKey, Record<string, string>>>;
}

/** Filtres propres à la vue : seuls les champs que l'API accepte pour cette vue sont proposés. */
export function ReportFilters({ view, value, onChange, companyId, period, options: enumOptions }: ReportFiltersProps) {
  const has = (key: ReportFilterKey) => view.filters.includes(key);
  const sites = useQuery({ queryKey: ['sites', 'report-filter', companyId], queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId, pageSize: 100 })}`), enabled: has('siteId') });
  const categories = useQuery({ queryKey: ['vehicle-categories'], queryFn: () => api<VehicleCategory[]>('/vehicle-categories'), enabled: has('categoryId') });
  const maintenanceTypes = useQuery({ queryKey: ['maintenance-types', 'all'], queryFn: () => api<MaintenanceTypeView[]>('/maintenance-types?includeArchived=true'), enabled: has('maintenanceTypeId') });
  const documentTypes = useQuery({ queryKey: ['document-types', 'all'], queryFn: () => api<DocumentTypeView[]>('/document-types?includeArchived=true'), enabled: has('documentTypeId') });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Recherche différée annulée si le panneau est remplacé (changement de rapport ou réinitialisation).
  useEffect(() => {
    const timer = searchTimer;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const fields = FIELD_ORDER.filter(has);
  if (fields.length === 0) return <p className="text-sm text-muted-foreground">Cette vue n’a pas d’autre filtre que la société courante.</p>;

  const id = (key: string) => `rapport-filtre-${key}`;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {fields.map((key) => {
        const label = FILTER_FIELD_LABELS[key];
        switch (key) {
          case 'from':
          case 'to':
            return (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={id(key)}>{label}</Label>
                <Input id={id(key)} type="date" value={value(key) || (period ? period[key] : '')} onChange={(e) => onChange({ [key]: e.target.value })} />
              </div>
            );
          case 'q':
            return (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={id(key)}>{label}</Label>
                <Input
                  id={id(key)}
                  type="search"
                  placeholder="Code, immatriculation, marque, VIN…"
                  defaultValue={value('q')}
                  maxLength={200}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (searchTimer.current) clearTimeout(searchTimer.current);
                    searchTimer.current = setTimeout(() => onChange({ q: next.trim() }), 350);
                  }}
                />
              </div>
            );
          case 'siteId':
            return (
              <OptionSelect
                key={key}
                id={id(key)}
                label={label}
                value={value(key)}
                allLabel="Tous les sites"
                loading={sites.isPending}
                failed={sites.isError}
                options={(sites.data?.items ?? []).map((s) => ({ value: s.id, label: s.status === 'ARCHIVE' ? `${s.name} (archivé)` : s.name }))}
                hint={sites.data && sites.data.total > sites.data.items.length ? `${sites.data.items.length} premiers sites sur ${sites.data.total} : choisissez une société dans l’en-tête pour restreindre la liste.` : undefined}
                onChange={(v) => onChange({ siteId: v })}
              />
            );
          case 'vehicleId':
            return (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={id(key)}>{label}</Label>
                <VehicleIdFilter id={id(key)} vehicleId={value(key)} companyId={companyId} onChange={(v) => onChange({ vehicleId: v })} />
              </div>
            );
          case 'driverId':
            return (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={id(key)}>{label}</Label>
                <DriverIdFilter id={id(key)} driverId={value(key)} companyId={companyId} onChange={(v) => onChange({ driverId: v })} />
              </div>
            );
          case 'supplierId':
            return (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={id(key)}>{label}</Label>
                <SupplierIdFilter id={id(key)} supplierId={value(key)} companyId={companyId} onChange={(v) => onChange({ supplierId: v })} />
              </div>
            );
          case 'categoryId':
            return (
              <OptionSelect
                key={key}
                id={id(key)}
                label={label}
                value={value(key)}
                allLabel="Toutes les catégories"
                loading={categories.isPending}
                failed={categories.isError}
                options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.label }))}
                onChange={(v) => onChange({ categoryId: v })}
              />
            );
          case 'maintenanceTypeId':
            return (
              <OptionSelect
                key={key}
                id={id(key)}
                label={label}
                value={value(key)}
                allLabel="Toutes les opérations"
                loading={maintenanceTypes.isPending}
                failed={maintenanceTypes.isError}
                options={(maintenanceTypes.data ?? []).map((t) => ({ value: t.id, label: t.status === 'ARCHIVE' ? `${t.label} (archivée)` : t.label }))}
                onChange={(v) => onChange({ maintenanceTypeId: v })}
              />
            );
          case 'documentTypeId':
            return (
              <OptionSelect
                key={key}
                id={id(key)}
                label={label}
                value={value(key)}
                allLabel="Tous les types"
                loading={documentTypes.isPending}
                failed={documentTypes.isError}
                options={(documentTypes.data ?? [])
                  .filter((t) => !value('ownerType') || t.ownerType === value('ownerType'))
                  .map((t) => ({ value: t.id, label: `${t.label}${t.status === 'ARCHIVE' ? ' (archivé)' : ''}` }))}
                onChange={(v) => onChange({ documentTypeId: v })}
              />
            );
          case 'status':
            return (
              <OptionSelect
                key={key}
                id={id(key)}
                label={label}
                value={value(key)}
                allLabel="Tous les statuts"
                options={Object.entries(view.statuses).map(([code, text]) => ({ value: code, label: text }))}
                onChange={(v) => onChange({ status: v })}
              />
            );
          case 'lateOnly':
          case 'blocking':
            return (
              <div key={key} className="flex items-center gap-3 self-end rounded-md border px-3 py-2">
                <Switch id={id(key)} checked={value(key) === 'true'} onCheckedChange={(checked) => onChange({ [key]: checked ? 'true' : '' })} />
                <Label htmlFor={id(key)} className="font-normal">
                  {key === 'lateOnly' ? 'Utilisations en retard uniquement' : 'Documents bloquants non conformes uniquement'}
                </Label>
              </div>
            );
          default: {
            const options = enumOptions[key];
            if (!options) return null;
            return (
              <OptionSelect
                key={key}
                id={id(key)}
                label={label}
                value={value(key)}
                allLabel="Sans filtre"
                options={Object.entries(options).map(([code, text]) => ({ value: code, label: text }))}
                onChange={(v) => onChange(key === 'ownerType' ? { ownerType: v, documentTypeId: '' } : { [key]: v })}
              />
            );
          }
        }
      })}
    </div>
  );
}

function OptionSelect({
  id,
  label,
  value,
  allLabel,
  options,
  onChange,
  loading,
  failed,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  allLabel: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  loading?: boolean;
  failed?: boolean;
  hint?: string;
}) {
  const hintId = `${id}-aide`;
  const known = !value || options.some((o) => o.value === value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
        <SelectTrigger id={id} className="w-full" aria-describedby={hint || failed ? hintId : undefined}>
          <SelectValue placeholder={loading ? 'Chargement…' : undefined} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {!known ? <SelectItem value={value}>{loading ? 'Chargement…' : 'Valeur hors liste'}</SelectItem> : null}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {failed ? (
        <p id={hintId} className="text-xs text-destructive">
          Liste indisponible : réessayez plus tard.
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
