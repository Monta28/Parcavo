'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { LOCATION_CONTEXT_LABELS } from '@parc-auto/contracts';
import { useSession } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { LocationReportView, SiteView } from '@/lib/vehicles-types';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';

const FREE = '__libre__';

export function LocationPanel({ vehicleId, companyId, canDeclare }: { vehicleId: string; companyId: string; canDeclare: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const reports = useQuery({ queryKey: ['vehicle', vehicleId, 'locations'], queryFn: () => api<Page<LocationReportView>>(`/vehicles/${vehicleId}/location-reports?pageSize=25`) });
  const sites = useQuery({ queryKey: ['sites', companyId], queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId, pageSize: 100, status: 'ACTIF' })}`) });
  const [siteId, setSiteId] = useState(FREE);
  const [placeLabel, setPlaceLabel] = useState('');
  // Heure murale du fuseau de l'organisation, indépendante du fuseau du navigateur.
  const [observedAt, setObservedAt] = useState(() => nowLocalInput(session.timezone));
  const [comment, setComment] = useState('');
  const declare = useMutation({
    mutationFn: () =>
      api(`/vehicles/${vehicleId}/location-reports`, {
        method: 'POST',
        body: { siteId: siteId === FREE ? undefined : siteId, placeLabel: siteId === FREE ? placeLabel : undefined, observedAt: localInputToIso(observedAt, session.timezone) ?? undefined, comment: comment || undefined },
      }),
    onSuccess: () => {
      toast.success('Localisation déclarée.');
      setComment('');
      void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Échec de la déclaration.'),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {canDeclare ? (
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Déclarer une localisation</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                declare.mutate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="site">Site</Label>
                <Select value={siteId} onValueChange={setSiteId}>
                  <SelectTrigger id="site">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FREE}>Lieu libre</SelectItem>
                    {(sites.data?.items ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {siteId === FREE ? (
                <div className="space-y-2">
                  <Label htmlFor="place">Lieu</Label>
                  <Input id="place" required value={placeLabel} onChange={(e) => setPlaceLabel(e.target.value)} placeholder="Ex. parking client, garage X" />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="observedAt">Date d’observation</Label>
                <Input id="observedAt" type="datetime-local" required value={observedAt} onChange={(e) => setObservedAt(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="comment">Commentaire</Label>
                <Textarea id="comment" value={comment} onChange={(e) => setComment(e.target.value)} />
              </div>
              <Button type="submit" disabled={declare.isPending}>
                {declare.isPending ? 'Enregistrement…' : 'Déclarer'}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      <div className={canDeclare ? 'lg:col-span-2' : 'lg:col-span-3'}>
        {reports.isPending ? (
          <LoadingState />
        ) : reports.isError ? (
          <ErrorState error={reports.error} retry={() => void reports.refetch()} />
        ) : reports.data.total === 0 ? (
          <EmptyState title="Aucune localisation déclarée" description="Une remise, une restitution ou une déclaration manuelle produira une entrée ici. Aucune position temps réel n’est suivie." />
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Observée le</TableHead>
                  <TableHead>Lieu</TableHead>
                  <TableHead>Contexte</TableHead>
                  <TableHead>Auteur</TableHead>
                  <TableHead>Commentaire</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.data.items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{formatDateTime(r.observedAt, session.timezone)}</TableCell>
                    <TableCell>{r.siteName ?? r.placeLabel}</TableCell>
                    <TableCell>{LOCATION_CONTEXT_LABELS[r.context as keyof typeof LOCATION_CONTEXT_LABELS] ?? r.context}</TableCell>
                    <TableCell>{r.createdByName ?? '—'}</TableCell>
                    <TableCell>{r.comment ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
