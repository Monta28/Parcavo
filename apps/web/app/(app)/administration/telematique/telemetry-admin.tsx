'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { ProviderStatusBadge, SimulatorBadge, SyncRunsTable, useCompanyCodes } from '@/components/telemetry/telemetry-display';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { PROVIDER_STATUS_LABELS, type CompanyTelemetryView, type ProviderView } from '@/lib/telemetry-types';
import { useListParams } from '@/lib/use-list-params';
import { ALL } from '../labels';
import { ProviderDetail } from './provider-detail';
import { ProviderDialog } from './provider-dialog';

/**
 * Administration de la télématique F11 (CDC 14.3 à 14.6 ; D-101, D-112, D-295 à D-297, D-303, D-304) :
 * activation du module par société (motif, audit), fournisseurs (création par type, paramètres
 * documentés, secrets en écriture seule, test de connexion, synchronisation manuelle, état, cycle de
 * vie) et exécutions. L'application fonctionne entièrement avec le module désactivé.
 */
export function TelemetryAdmin() {
  const { get, set } = useListParams();
  const providerId = get('fournisseur');
  return (
    <div>
      <PageHeader
        title="Télématique (F11)"
        description="Connecteur télématique : fournisseurs, secrets, activation par société et exécutions de synchronisation. Tous les parcours manuels fonctionnent sans ce module."
      />
      {providerId ? (
        <ProviderDetail id={providerId} onBack={() => set({ fournisseur: '' })} />
      ) : (
        <div className="space-y-6">
          <CompaniesActivation />
          <ProvidersSection onOpen={(id) => set({ fournisseur: id })} />
          <RunsSection />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Activation par société (D-101, D-295)
// ---------------------------------------------------------------------------------------------

function CompaniesActivation() {
  const { session } = useAppScope();
  const companies = useQuery({ queryKey: ['telemetry', 'companies'], queryFn: () => api<CompanyTelemetryView[]>('/telemetry/companies') });
  const [target, setTarget] = useState<CompanyTelemetryView | null>(null);
  const statusOf = (id: string) => session.companies.find((c) => c.id === id)?.status ?? 'ACTIF';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Activation par société</CardTitle>
        <CardDescription>
          Désactivé par défaut. Sans activation, aucun appel au fournisseur n’est fait pour la société. La désactivation arrête la synchronisation, conserve associations et relevés, et résout les alertes F11.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {companies.isPending ? (
          <LoadingState />
        ) : companies.isError ? (
          <ErrorState error={companies.error} retry={() => void companies.refetch()} />
        ) : companies.data.length === 0 ? (
          <EmptyState title="Aucune société" />
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Société</TableHead>
                  <TableHead>Module F11</TableHead>
                  <TableHead>Fournisseurs couvrants</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies.data.map((c) => {
                  const archived = statusOf(c.companyId) !== 'ACTIF';
                  return (
                    <TableRow key={c.companyId}>
                      <TableCell className="whitespace-normal">
                        <span className="font-medium">{c.code}</span> — {c.legalName}
                        {archived ? <span className="block text-xs text-muted-foreground">Société archivée</span> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge label={c.telemetryEnabled ? 'Activé' : 'Désactivé'} tone={c.telemetryEnabled ? 'info' : 'neutral'} />
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {c.providers.length === 0 ? (
                          <span className="text-muted-foreground">Aucun</span>
                        ) : (
                          <ul className="space-y-1">
                            {c.providers.map((p) => (
                              <li key={p.id} className="flex flex-wrap items-center gap-1">
                                {p.name} <ProviderStatusBadge status={p.status} />
                                {p.kind === 'SIMULATEUR' ? <SimulatorBadge /> : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.telemetryEnabled ? (
                          <Button variant="outline" size="sm" onClick={() => setTarget(c)} aria-label={`Désactiver le module pour ${c.code}`}>
                            Désactiver
                          </Button>
                        ) : archived ? null : (
                          <Button size="sm" onClick={() => setTarget(c)} aria-label={`Activer le module pour ${c.code}`}>
                            Activer
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      {target ? <CompanyTelemetryDialog company={target} onClose={() => setTarget(null)} /> : null}
    </Card>
  );
}

function CompanyTelemetryDialog({ company, onClose }: { company: CompanyTelemetryView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const enabling = !company.telemetryEnabled;
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const mutation = useMutation({
    mutationFn: () =>
      api<CompanyTelemetryView>(`/telemetry/companies/${company.companyId}/${enabling ? 'enable' : 'disable'}`, { method: 'POST', body: { reason: reason.trim(), expectedVersion: company.version } }),
    onSuccess: (saved) => {
      if (enabling) toast.success(`Module télématique activé pour ${saved.code}.`);
      else toast.success(`Module télématique désactivé pour ${saved.code}${saved.resolvedAlerts ? ` : ${saved.resolvedAlerts} alerte(s) F11 résolue(s)` : ''}.`);
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
      void queryClient.invalidateQueries({ queryKey: ['companies'] });
      onClose();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        toast.error('Opération impossible.');
        return;
      }
      setFieldErrors(error.fieldErrors);
      toast.error(error.message);
      if (error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
        onClose();
      }
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {enabling ? 'Activer' : 'Désactiver'} le module télématique pour {company.code}
          </DialogTitle>
          <DialogDescription>
            {enabling
              ? 'Les fournisseurs actifs qui couvrent la société pourront être interrogés. Aucun relevé n’est ingéré avant la confirmation des associations par le chef de parc ; la reprise après une désactivation est bornée à la période d’inactivité.'
              : 'La synchronisation s’arrête pour cette société. Les associations sont conservées (suspendues), les relevés déjà acceptés restent valides et les alertes F11 actives sont résolues avec le motif « module désactivé ».'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="company-telemetry-reason">Motif * (audité)</Label>
            <Textarea id="company-telemetry-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" variant={enabling ? 'default' : 'destructive'} disabled={mutation.isPending || reason.trim().length < 3}>
              {mutation.isPending ? 'Traitement…' : enabling ? 'Activer' : 'Désactiver'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Fournisseurs
// ---------------------------------------------------------------------------------------------

function ProvidersSection({ onOpen }: { onOpen: (id: string) => void }) {
  const { session } = useAppScope();
  const companyCode = useCompanyCodes();
  const { get, set, page } = useListParams();
  const q = get('q');
  const status = get('statut');
  const query = toQuery({ q, status, page, pageSize: 25 });
  const providers = useQuery({ queryKey: ['telemetry', 'providers', query], queryFn: () => api<Page<ProviderView>>(`/telemetry/providers${query}`) });
  const [creating, setCreating] = useState(false);
  // Instant d'affichage figé au montage, pour l'état du coupe-circuit.
  const [now] = useState(() => Date.now());

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base">Fournisseurs</CardTitle>
          <CardDescription>Un fournisseur est créé en brouillon, reçoit ses secrets puis est activé. Le canal RPA n’est pas activable en V1.</CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Nouveau fournisseur
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Input aria-label="Rechercher un fournisseur" placeholder="Nom…" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
          <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
            <SelectTrigger aria-label="Statut">
              <SelectValue placeholder="Statut" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              {Object.entries(PROVIDER_STATUS_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {providers.isPending ? (
          <LoadingState />
        ) : providers.isError ? (
          <ErrorState error={providers.error} retry={() => void providers.refetch()} />
        ) : providers.data.total === 0 ? (
          <EmptyState
            title="Aucun fournisseur"
            description={q || status ? 'Aucun fournisseur ne correspond aux filtres.' : 'Le module télématique reste inactif tant qu’aucun fournisseur n’est configuré et activé (annexe A).'}
          />
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nom</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead className="hidden md:table-cell">Sociétés</TableHead>
                  <TableHead className="hidden lg:table-cell">Intervalle</TableHead>
                  <TableHead>Dernière réussite</TableHead>
                  <TableHead className="hidden md:table-cell">Échecs</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.data.items.map((p) => {
                  const circuitOpen = p.circuitOpenUntil !== null && new Date(p.circuitOpenUntil).getTime() > now;
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium whitespace-normal">{p.name}</TableCell>
                      <TableCell className="whitespace-normal">
                        {p.isSimulator ? <SimulatorBadge /> : p.kindLabel}
                      </TableCell>
                      <TableCell>
                        <ProviderStatusBadge status={p.status} />
                      </TableCell>
                      <TableCell className="hidden whitespace-normal md:table-cell">{p.companyIds.length > 0 ? p.companyIds.map(companyCode).join(', ') : '—'}</TableCell>
                      <TableCell className="hidden lg:table-cell">{p.syncIntervalMinutes} min</TableCell>
                      <TableCell>{p.lastSuccessAt ? formatDateTime(p.lastSuccessAt, session.timezone) : 'Aucune'}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {circuitOpen ? <StatusBadge label="Appels suspendus (coupe-circuit ou quota)" tone="danger" /> : p.consecutiveFailures > 0 ? <StatusBadge label={`${p.consecutiveFailures} échec(s)`} tone="warning" /> : '0'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => onOpen(p.id)} aria-label={`Gérer le fournisseur ${p.name}`}>
                          Gérer
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PaginationControls page={providers.data.page} pageSize={providers.data.pageSize} total={providers.data.total} onPageChange={(p) => set({ page: p })} />
          </div>
        )}
      </CardContent>
      {creating ? (
        <ProviderDialog
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
          onSaved={(saved) => {
            setCreating(false);
            onOpen(saved.id);
          }}
        />
      ) : null}
    </Card>
  );
}

function RunsSection() {
  const providers = useQuery({ queryKey: ['telemetry', 'providers', 'all'], queryFn: () => api<Page<ProviderView>>('/telemetry/providers?pageSize=100') });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Exécutions de synchronisation</CardTitle>
        <CardDescription>Chaque exécution est tracée : déclencheur, résultat, volumes et erreurs expurgées (aucun secret).</CardDescription>
      </CardHeader>
      <CardContent>
        <SyncRunsTable providers={providers.data?.items ?? []} companyId={null} />
      </CardContent>
    </Card>
  );
}
