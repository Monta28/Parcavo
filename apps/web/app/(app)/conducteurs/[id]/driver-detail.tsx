'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAppScope, useRoleIn } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { DRIVER_STATUS_LABELS, type DepartmentView, type DriverUsageView, type DriverView, type LinkedUserView } from '@/lib/drivers-types';
import { formatDate, formatDateTime, fullName } from '@/lib/format';
import type { SiteView } from '@/lib/vehicles-types';
import { DeactivateDialog } from './deactivate-dialog';
import { DriverAssignmentsCard } from './driver-assignments-card';
import { DriverUsagesPanel } from './driver-usages-panel';
import { PermitPanel } from './permit-panel';

export function DriverDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const driver = useQuery({ queryKey: ['driver', id], queryFn: () => api<DriverView>(`/drivers/${id}`) });
  const role = useRoleIn(driver.data?.companyId ?? null);
  const isManager = session.isAdmin || role === 'ADMIN' || role === 'CHEF_PARC';
  const isOperational = isManager || role === 'OPERATEUR';
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  // Nouvelle instance du dialogue à chaque ouverture : le motif saisi précédemment n'est pas réutilisé.
  const [deactivateKey, setDeactivateKey] = useState(0);
  const [reactivateOpen, setReactivateOpen] = useState(false);

  const onSaved = (updated: DriverView, message: string) => {
    toast.success(message);
    queryClient.setQueryData(['driver', id], updated);
    void queryClient.invalidateQueries({ queryKey: ['drivers'] });
  };
  const onFailed = (error: unknown, fallback: string) => {
    toast.error(isApiError(error) ? error.message : fallback);
    // Version obsolète : on recharge la fiche pour repartir de l'état courant.
    if (isApiError(error) && error.status === 409) void queryClient.invalidateQueries({ queryKey: ['driver', id] });
  };

  const deactivate = useMutation({
    mutationFn: (input: { reason: string; cancelFutureReservations: boolean }) => api<DriverView>(`/drivers/${id}/deactivate`, { method: 'POST', body: { ...input, expectedVersion: driver.data?.version } }),
    onSuccess: (updated) => {
      setDeactivateOpen(false);
      onSaved(updated, 'Conducteur désactivé.');
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
    },
    onError: (error) => onFailed(error, 'Désactivation impossible.'),
  });
  const reactivate = useMutation({
    mutationFn: () => api<DriverView>(`/drivers/${id}/reactivate`, { method: 'POST', body: { expectedVersion: driver.data?.version } }),
    onSuccess: (updated) => onSaved(updated, 'Conducteur réactivé.'),
    onError: (error) => onFailed(error, 'Réactivation impossible.'),
  });

  if (driver.isPending) return <LoadingState label="Chargement de la fiche…" />;
  if (driver.isError) return <ErrorState error={driver.error} retry={() => void driver.refetch()} />;
  const d = driver.data;
  const name = fullName(d);
  const company = session.companies.find((c) => c.id === d.companyId);
  const permit = d.permits[0];

  return (
    <div>
      <PageHeader
        title={name}
        description={`Identifiant ${d.code}${company ? ` · Société ${company.code} · ${company.name}` : ''}`}
        actions={
          <>
            {isOperational ? (
              <Button variant="outline" asChild>
                <Link href={`/conducteurs/${id}/modifier`}>Modifier</Link>
              </Button>
            ) : null}
            {isManager && d.status === 'ACTIF' ? (
              <Button
                variant="outline"
                onClick={() => {
                  deactivate.reset();
                  setDeactivateKey((k) => k + 1);
                  setDeactivateOpen(true);
                }}
              >
                Désactiver
              </Button>
            ) : null}
            {isManager && d.status === 'INACTIF' ? (
              <Button variant="outline" disabled={reactivate.isPending} onClick={() => setReactivateOpen(true)}>
                {reactivate.isPending ? 'Réactivation…' : 'Réactiver'}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge label={DRIVER_STATUS_LABELS[d.status] ?? d.status} tone={d.status === 'ACTIF' ? 'success' : 'neutral'} />
        {d.currentUsageId ? <StatusBadge label="Utilisation en cours" tone="info" /> : null}
        <StatusBadge label={d.userId ? 'Compte utilisateur lié' : 'Sans compte utilisateur'} tone="neutral" />
      </div>

      <Tabs defaultValue="fiche">
        <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
          <TabsTrigger value="fiche">Fiche et permis</TabsTrigger>
          <TabsTrigger value="utilisations">Utilisations</TabsTrigger>
        </TabsList>

        <TabsContent value="fiche">
          <div className="grid gap-4 md:grid-cols-2">
            <IdentityCard driver={d} companyLabel={company ? `${company.code} · ${company.name}` : null} timezone={session.timezone} />
            <CurrentUsageCard usageId={d.currentUsageId} timezone={session.timezone} />
            <LinkedAccountCard userId={d.userId} />
            <div className="md:col-span-2">
              <PermitPanel driverId={id} companyId={d.companyId} permit={permit} canEdit={isOperational} />
            </div>
            {session.isDriverOnly ? null : (
              <div className="md:col-span-2">
                <DriverAssignmentsCard driverId={id} />
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="utilisations">
          <DriverUsagesPanel driverId={id} />
        </TabsContent>
      </Tabs>

      {isManager ? <DeactivateDialog key={deactivateKey} open={deactivateOpen} onOpenChange={setDeactivateOpen} driverName={name} pending={deactivate.isPending} error={deactivate.error} onSubmit={(input) => deactivate.mutate(input)} /> : null}

      <AlertDialog open={reactivateOpen} onOpenChange={setReactivateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Réactiver {name} ?</AlertDialogTitle>
            <AlertDialogDescription>Le conducteur pourra de nouveau recevoir un véhicule et être associé à des réservations. L’opération est journalisée.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={() => reactivate.mutate()}>Réactiver</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IdentityCard({ driver: d, companyLabel, timezone }: { driver: DriverView; companyLabel: string | null; timezone: string }) {
  // Libellés du site et du service : référentiels de la société du conducteur.
  const sites = useQuery({
    queryKey: ['sites', d.companyId, 'all'],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: d.companyId, pageSize: 100 })}`),
    enabled: Boolean(d.siteId),
  });
  const departments = useQuery({
    queryKey: ['departments', d.companyId],
    queryFn: () => api<DepartmentView[]>(`/departments${toQuery({ companyId: d.companyId })}`),
    enabled: Boolean(d.departmentId),
  });
  const siteName = d.siteId ? (sites.data?.items.find((s) => s.id === d.siteId)?.name ?? (sites.isPending ? 'Chargement…' : 'Site non disponible')) : null;
  const departmentName = d.departmentId ? (departments.data?.find((s) => s.id === d.departmentId)?.name ?? (departments.isPending ? 'Chargement…' : 'Service non disponible')) : null;

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">Fiche</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Identifiant interne" value={d.code} />
          <Field label="Nom" value={d.lastName} />
          <Field label="Prénom" value={d.firstName} />
          <Field label="Société" value={companyLabel} />
          <Field label="Site" value={siteName} />
          <Field label="Service" value={departmentName} />
          <Field label="Téléphone" value={d.phone} />
          <Field label="E-mail" value={d.email} />
          <Field label="Créé le" value={formatDate(d.createdAt, timezone)} />
          <div className="sm:col-span-2 lg:col-span-3">
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-wrap">{d.notes ?? '—'}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function CurrentUsageCard({ usageId, timezone }: { usageId: string | null; timezone: string }) {
  const usage = useQuery({ queryKey: ['usage', usageId], queryFn: () => api<DriverUsageView>(`/usages/${usageId}`), enabled: Boolean(usageId) });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Utilisation en cours</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {!usageId ? (
          <p className="text-muted-foreground">Aucune utilisation en cours.</p>
        ) : usage.isPending ? (
          <LoadingState />
        ) : usage.isError ? (
          <div className="space-y-1">
            <p className="text-muted-foreground">{isApiError(usage.error) ? usage.error.message : 'Détail de l’utilisation indisponible.'}</p>
            <Link href={`/utilisations/${usageId}`} className="underline underline-offset-4">
              Ouvrir l’utilisation
            </Link>
          </div>
        ) : (
          <div className="space-y-1">
            <p>
              <Link href={`/vehicules/${usage.data.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                {usage.data.vehicleCode} · {usage.data.vehicleRegistration}
              </Link>
            </p>
            <p className="text-muted-foreground">Remis le {formatDateTime(usage.data.checkedOutAt, timezone)}</p>
            <p className="text-muted-foreground">Retour prévu le {formatDateTime(usage.data.expectedReturnAt, timezone)}</p>
            {usage.data.isLate ? <StatusBadge label="En retard" tone="danger" /> : null}
            <p>
              <Link href={`/utilisations/${usageId}`} className="underline underline-offset-4">
                Ouvrir l’utilisation
              </Link>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LinkedAccountCard({ userId }: { userId: string | null }) {
  const { session } = useAppScope();
  const isSelf = userId !== null && userId === session.userId;
  // Le détail d'un compte n'est consultable que par l'administrateur (GET /users/:id).
  const user = useQuery({ queryKey: ['user', userId], queryFn: () => api<LinkedUserView>(`/users/${userId}`), enabled: Boolean(userId) && session.isAdmin && !isSelf });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Compte utilisateur lié</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {!userId ? (
          <p className="text-muted-foreground">Aucun compte lié. La liaison d’un compte à ce conducteur est réalisée par un administrateur depuis la fiche de l’utilisateur.</p>
        ) : isSelf ? (
          <p>
            Ce conducteur est lié à votre compte
            <span className="block text-muted-foreground">{session.email}</span>
          </p>
        ) : !session.isAdmin ? (
          <p>Un compte utilisateur est lié à ce conducteur.</p>
        ) : user.isPending ? (
          <LoadingState />
        ) : user.isError ? (
          <p className="text-muted-foreground">Un compte est lié, mais son détail est indisponible : {isApiError(user.error) ? user.error.message : 'erreur inconnue.'}</p>
        ) : (
          <div className="space-y-1">
            <p className="font-medium">{fullName(user.data)}</p>
            <p className="text-muted-foreground">{user.data.email}</p>
            <StatusBadge label={user.data.status === 'ACTIF' ? 'Compte actif' : 'Compte désactivé'} tone={user.data.status === 'ACTIF' ? 'success' : 'neutral'} />
            <p className="text-muted-foreground">Dernière connexion : {user.data.lastLoginAt ? formatDateTime(user.data.lastLoginAt, session.timezone) : 'jamais'}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value ?? '—'}</dd>
    </div>
  );
}
