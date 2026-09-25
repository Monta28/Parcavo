'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, PlugZap, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { TELEMETRY_CHANNEL_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { SyncDialog } from '@/components/telemetry/sync-dialog';
import { ProviderStatusBadge, ProviderSyncState, SimulatorBadge, SimulatorNotice, SyncRunsTable, useCompanyCodes } from '@/components/telemetry/telemetry-display';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import {
  CREDENTIAL_FORMAT_HINTS,
  CREDENTIAL_KIND_LABELS,
  type CredentialKind,
  type CredentialStatus,
  type DiscoveryResult,
  type ProviderHealthView,
  type ProviderView,
} from '@/lib/telemetry-types';
import { ConfirmDialog } from '../confirm-dialog';
import { ProviderDialog } from './provider-dialog';
import { WebhookSection } from './webhook-section';

type Transition = 'activate' | 'suspend' | 'deactivate';
const TRANSITION_LABELS: Record<Transition, { title: string; action: string; done: string }> = {
  activate: { title: 'Activer le fournisseur', action: 'Activer', done: 'Fournisseur activé.' },
  suspend: { title: 'Suspendre le fournisseur', action: 'Suspendre', done: 'Fournisseur suspendu : plus aucune synchronisation.' },
  deactivate: { title: 'Désactiver le fournisseur', action: 'Désactiver', done: 'Fournisseur désactivé : données conservées.' },
};

/**
 * Fiche d'un fournisseur pour l'administrateur (CDC 14.3 à 14.6 ; D-112, D-296, D-297, D-303, D-304) :
 * configuration, secrets en écriture seule (seul l'état « configuré le … » est affiché), test de
 * connexion réel, découverte des unités, synchronisation manuelle (sauf canal WEBHOOK : lots poussés, section
 * « Réception webhook » avec génération et rotation du secret de signature), état et cycle de vie.
 */
export function ProviderDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const companyCode = useCompanyCodes();
  const provider = useQuery({ queryKey: ['telemetry', 'provider', id], queryFn: () => api<ProviderView>(`/telemetry/providers/${id}`) });
  const [editing, setEditing] = useState(false);
  const [transition, setTransition] = useState<Transition | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [credential, setCredential] = useState<CredentialKind | null>(null);
  const [revoking, setRevoking] = useState<CredentialKind | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [health, setHealth] = useState<ProviderHealthView | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
  const onError = (fallback: string) => (error: unknown) => {
    toast.error(isApiError(error) ? error.message : fallback);
    if (isApiError(error) && error.status === 409) refresh();
  };

  const testConnection = useMutation({
    mutationFn: () => api<ProviderHealthView>(`/telemetry/providers/${id}/health`, { method: 'POST' }),
    onSuccess: (result) => {
      setHealth(result);
      if (result.ok) toast.success('Connexion réussie.');
      else toast.error('Connexion en échec : voir le détail.');
    },
    onError: onError('Test de connexion impossible.'),
  });
  const discover = useMutation({
    mutationFn: () => api<DiscoveryResult>(`/telemetry/providers/${id}/discover`, { method: 'POST' }),
    onSuccess: (result) => {
      setDiscovery(result);
      toast.success(`Découverte terminée : ${result.unitsSeen} unité(s), ${result.proposalsCreated} proposition(s) créée(s).`);
      refresh();
    },
    onError: (error) => {
      onError('Découverte impossible.')(error);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (p: ProviderView) => api<void>(`/telemetry/providers/${p.id}?expectedVersion=${p.version}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Brouillon supprimé.');
      setDeleting(false);
      onBack();
      queryClient.removeQueries({ queryKey: ['telemetry', 'provider', id] });
      refresh();
    },
    onError: onError('Suppression impossible.'),
  });
  const revoke = useMutation({
    mutationFn: (kind: CredentialKind) => api<CredentialStatus>(`/telemetry/providers/${id}/credentials/${kind}`, { method: 'DELETE' }),
    onSuccess: (status) => {
      toast.success(`${CREDENTIAL_KIND_LABELS[status.kind]} révoqué.`);
      setRevoking(null);
      refresh();
    },
    onError: onError('Révocation impossible.'),
  });

  const back = (
    <Button variant="ghost" size="sm" onClick={onBack} className="mb-4">
      <ArrowLeft className="size-4" /> Retour aux fournisseurs
    </Button>
  );
  if (provider.isPending) return <>{back}<LoadingState /></>;
  if (provider.isError) return <>{back}<ErrorState error={provider.error} retry={() => void provider.refetch()} /></>;
  const p = provider.data;
  const closed = p.status === 'DESACTIVE';

  return (
    <div className="space-y-4">
      {back}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
            {p.name} <ProviderStatusBadge status={p.status} />
            {p.isSimulator ? <SimulatorBadge /> : null}
          </CardTitle>
          <CardDescription>
            {p.kindLabel} · canal {TELEMETRY_CHANNEL_LABELS[p.channel]}
            {p.createdAt ? ` · créé le ${formatDateTime(p.createdAt, session.timezone)}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {p.isSimulator ? <SimulatorNotice notice={p.notice} /> : null}
          <div className="flex flex-wrap gap-2">
            {!closed ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Modifier la configuration
              </Button>
            ) : null}
            {!closed ? (
              <Button variant="outline" size="sm" disabled={testConnection.isPending} onClick={() => testConnection.mutate()}>
                <PlugZap className="size-4" /> {testConnection.isPending ? 'Test en cours…' : 'Tester la connexion'}
              </Button>
            ) : null}
            {p.status === 'BROUILLON' || p.status === 'ACTIF' ? (
              <Button variant="outline" size="sm" disabled={discover.isPending} onClick={() => discover.mutate()}>
                <Search className="size-4" /> {discover.isPending ? 'Découverte…' : 'Découvrir les unités'}
              </Button>
            ) : null}
            {p.status === 'ACTIF' && p.channel !== 'WEBHOOK' ? (
              <Button variant="outline" size="sm" onClick={() => setSyncing(true)}>
                <RefreshCw className="size-4" /> Synchroniser maintenant
              </Button>
            ) : null}
            {p.status === 'BROUILLON' || p.status === 'SUSPENDU' ? (
              <Button size="sm" onClick={() => setTransition('activate')}>
                Activer
              </Button>
            ) : null}
            {p.status === 'ACTIF' ? (
              <Button variant="outline" size="sm" onClick={() => setTransition('suspend')}>
                Suspendre
              </Button>
            ) : null}
            {!closed ? (
              <Button variant="outline" size="sm" onClick={() => setTransition('deactivate')}>
                Désactiver
              </Button>
            ) : null}
            {p.status === 'BROUILLON' ? (
              <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
                Supprimer le brouillon
              </Button>
            ) : null}
          </div>

          {health ? (
            <div role="status" className={`rounded-md border p-3 text-sm ${health.ok ? 'border-success/30 bg-success/10' : 'border-destructive/30 bg-destructive/5'}`}>
              <p className="font-medium">{health.ok ? 'Connexion réussie' : 'Connexion en échec'}</p>
              <p className="break-words">{health.message}</p>
              <p className="text-xs text-muted-foreground">
                Testé le {formatDateTime(health.checkedAt, session.timezone)}
                {health.latencyMs !== null ? ` · ${health.latencyMs} ms` : ''}
              </p>
            </div>
          ) : null}
          {discovery ? (
            <div role="status" className="rounded-md border p-3 text-sm">
              <p className="font-medium">Dernière découverte</p>
              <p>
                {discovery.unitsSeen} unité(s) vue(s) ({discovery.unitsCreated} nouvelle(s), {discovery.unitsUpdated} mise(s) à jour, {discovery.unitsMissing} absente(s) chez le fournisseur) ;{' '}
                {discovery.proposalsCreated} proposition(s) créée(s), {discovery.proposalsPending} en attente de confirmation, {discovery.unmapped} unité(s) non associée(s){discovery.ignored > 0 ? `, ${discovery.ignored} ignorée(s)` : ''}.
              </p>
              <p className="text-xs text-muted-foreground">Aucun relevé n’est ingéré avant la confirmation des associations par le chef de parc (page Télématique).</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">État de synchronisation</CardTitle>
          </CardHeader>
          <CardContent>
            <ProviderSyncState provider={p} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
            <CardDescription>Paramètres non secrets ; les secrets ne sont jamais affichés.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">URL de base</dt>
                <dd className="break-all">{p.baseUrl ?? 'Sans objet ou non renseignée'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reprise initiale</dt>
                <dd>{p.backfillDays !== undefined ? `${p.backfillDays} jour(s)` : '—'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sociétés couvertes</dt>
                <dd>{p.companyIds.length > 0 ? p.companyIds.map(companyCode).join(', ') : 'Aucune'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Paramètres</dt>
                <dd>
                  {p.settings && Object.keys(p.settings).length > 0 ? (
                    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(p.settings, null, 2)}</pre>
                  ) : (
                    'Aucun (exigés à l’activation)'
                  )}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      {p.channel === 'WEBHOOK' ? <WebhookSection provider={p} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" aria-hidden="true" /> Secrets (écriture seule)
          </CardTitle>
          <CardDescription>Chiffrés au repos avec une clé hors base ; jamais renvoyés par l’API ni journalisés. Un nouveau dépôt remplace le précédent (rotation).</CardDescription>
        </CardHeader>
        <CardContent>
          {(p.credentials ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Ce type de fournisseur n’accepte aucun secret.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {(p.credentials ?? []).map((c) => (
                <li key={c.kind} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div>
                    <p className="font-medium">{CREDENTIAL_KIND_LABELS[c.kind]}</p>
                    <p className="text-sm text-muted-foreground">{c.configured ? `Configuré le ${formatDateTime(c.rotatedAt, session.timezone)}` : 'Non configuré'}</p>
                    {c.previousValidUntil ? <p className="text-xs text-muted-foreground">Ancien secret accepté jusqu’au {formatDateTime(c.previousValidUntil, session.timezone)}</p> : null}
                  </div>
                  {!closed ? (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setCredential(c.kind)} aria-label={`${c.configured ? 'Remplacer' : 'Déposer'} : ${CREDENTIAL_KIND_LABELS[c.kind]}`}>
                        {c.configured ? 'Remplacer' : 'Déposer'}
                      </Button>
                      {c.configured ? (
                        <Button variant="outline" size="sm" onClick={() => setRevoking(c.kind)} aria-label={`Révoquer : ${CREDENTIAL_KIND_LABELS[c.kind]}`}>
                          Révoquer
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exécutions de ce fournisseur</CardTitle>
          <CardDescription>Synchronisations (par société) et découvertes des unités ; résumés d’erreur expurgés.</CardDescription>
        </CardHeader>
        <CardContent>
          <SyncRunsTable providers={[{ id: p.id, name: p.name }]} companyId={null} fixedProviderId={p.id} />
        </CardContent>
      </Card>

      {editing ? (
        <ProviderDialog
          provider={p}
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
          onSaved={() => setEditing(false)}
        />
      ) : null}
      {transition ? <TransitionDialog provider={p} transition={transition} onClose={() => setTransition(null)} /> : null}
      {credential ? <CredentialDialog providerId={p.id} kind={credential} onClose={() => setCredential(null)} /> : null}
      {syncing ? <SyncDialog provider={p} onClose={() => setSyncing(false)} /> : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(false);
        }}
        title={`Supprimer le brouillon ${p.name} ?`}
        description={<p>Seul un brouillon jamais synchronisé peut être supprimé. Un fournisseur utilisé se désactive (son historique est conservé).</p>}
        confirmLabel="Supprimer"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(p)}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setRevoking(null);
        }}
        title={revoking ? `Révoquer : ${CREDENTIAL_KIND_LABELS[revoking]} ?` : 'Révoquer le secret ?'}
        description={<p>Le secret est supprimé de la base. Les synchronisations échoueront tant qu’un nouveau secret n’est pas déposé.</p>}
        confirmLabel="Révoquer"
        destructive
        pending={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking);
        }}
      />
    </div>
  );
}

function TransitionDialog({ provider, transition, onClose }: { provider: ProviderView; transition: Transition; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const labels = TRANSITION_LABELS[transition];
  const needsReason = transition !== 'activate';
  const mutation = useMutation({
    mutationFn: () => api<ProviderView>(`/telemetry/providers/${provider.id}/${transition}`, { method: 'POST', body: { reason: reason.trim() || undefined, expectedVersion: provider.version } }),
    onSuccess: () => {
      toast.success(labels.done);
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
      onClose();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        toast.error('Opération impossible.');
        return;
      }
      setFieldErrors(error.fieldErrors);
      const listed = error.details?.['problems'];
      setProblems(Array.isArray(listed) ? listed.filter((x): x is string => typeof x === 'string') : []);
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
            {labels.title} {provider.name}
          </DialogTitle>
          <DialogDescription>
            {transition === 'activate'
              ? 'L’activation exige une configuration complète : paramètres valides, URL de base pour une API, au moins une société couverte et le secret requis. La synchronisation ne concerne que les sociétés où le module est activé.'
              : transition === 'suspend'
                ? 'Plus aucune synchronisation tant que le fournisseur est suspendu ; ses alertes sont résolues. Il peut être réactivé.'
                : 'Désactivation définitive : plus aucune synchronisation ; les associations en cours sont clôturées (historique conservé) et les propositions rejetées, les véhicules redeviennent sans unité ; unités et relevés sont conservés.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            setProblems([]);
            mutation.mutate();
          }}
        >
          {needsReason ? (
            <div className="space-y-2">
              <Label htmlFor="transition-reason">Motif *</Label>
              <Textarea id="transition-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
              <FieldError errors={fieldErrors} name="reason" />
            </div>
          ) : null}
          {problems.length > 0 ? (
            <ul role="alert" className="list-disc space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 pl-8 text-sm text-destructive">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" variant={transition === 'deactivate' ? 'destructive' : 'default'} disabled={mutation.isPending || (needsReason && reason.trim().length < 3)}>
              {mutation.isPending ? 'Traitement…' : labels.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Dépôt d'un secret en écriture seule : la valeur saisie n'est jamais relue ni réaffichée. */
function CredentialDialog({ providerId, kind, onClose }: { providerId: string; kind: CredentialKind; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const multiline = kind === 'SFTP';
  const mutation = useMutation({
    mutationFn: () => api<CredentialStatus>(`/telemetry/providers/${providerId}/credentials/${kind}`, { method: 'PUT', body: { secret } }),
    onSuccess: () => {
      setSecret('');
      toast.success(`${CREDENTIAL_KIND_LABELS[kind]} enregistré (chiffré).`);
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
      onClose();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
      } else toast.error('Enregistrement impossible.');
    },
  });
  const close = () => {
    setSecret('');
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && close()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{CREDENTIAL_KIND_LABELS[kind]}</DialogTitle>
          <DialogDescription>Utilisez un compte dédié en lecture seule, distinct des comptes personnels. La valeur est chiffrée à l’enregistrement et ne sera plus jamais affichée.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="credential-secret">Secret *</Label>
            {multiline ? (
              <Textarea id="credential-secret" rows={5} className="font-mono text-xs" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" aria-describedby="secret-hint secret-error" />
            ) : (
              <Input id="credential-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} aria-describedby="secret-hint secret-error" />
            )}
            <p id="secret-hint" className="text-xs text-muted-foreground">
              {CREDENTIAL_FORMAT_HINTS[kind]}
            </p>
            <FieldError errors={fieldErrors} name="secret" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={close}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending || secret.trim().length < 4}>
              {mutation.isPending ? 'Chiffrement…' : 'Enregistrer le secret'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
