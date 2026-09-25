'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Webhook } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import { type CredentialStatus, type ProviderView, WEBHOOK_DELIVERY_STATUS_LABELS, type WebhookDeliveryStatus, type WebhookView } from '@/lib/telemetry-types';
import { generateWebhookSecret } from '@/lib/webhook-secret';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

function deliveryTone(status: WebhookDeliveryStatus): Tone {
  switch (status) {
    case 'TRAITE':
      return 'success';
    case 'ECHEC':
      return 'danger';
    case 'IGNORE':
      return 'warning';
    default:
      return 'info';
  }
}

async function copyText(value: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copié dans le presse-papiers.`);
  } catch {
    toast.error('Copie impossible : sélectionnez le texte et copiez-le manuellement.');
  }
}

/**
 * Réception webhook d'un fournisseur de canal WEBHOOK (CDC 14.4, 14.6 ; D-298) pour l'administrateur :
 * URL et règles de signature à communiquer au fournisseur, génération et rotation du secret de signature
 * (affiché une seule fois, déposé en écriture seule), état de la file et derniers lots reçus. Tous les
 * contrôles (signature, taille, débit, format) sont faits par l'API ; l'écran n'affiche que ses réponses.
 */
export function WebhookSection({ provider }: { provider: ProviderView }) {
  const { session } = useAppScope();
  const [generating, setGenerating] = useState(false);
  const view = useQuery({
    queryKey: ['telemetry', 'provider', provider.id, 'webhook'],
    queryFn: () => api<WebhookView>(`/telemetry/providers/${provider.id}/webhook`),
    refetchInterval: (q) => ((q.state.data?.counts.pending ?? 0) > 0 ? 10_000 : false),
  });
  const closed = provider.status === 'DESACTIVE';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Webhook className="size-4" aria-hidden="true" /> Réception webhook
        </CardTitle>
        <CardDescription>
          Le fournisseur pousse ses lots vers l’URL ci-dessous, signés avec le secret de signature. L’application ne fait que les déposer dans une file ; le worker les ingère ensuite avec les mêmes contrôles que la synchronisation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.isPending ? (
          <LoadingState />
        ) : view.isError ? (
          <ErrorState error={view.error} retry={() => void view.refetch()} />
        ) : (
          <>
            {view.data.notice ? (
              <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                {view.data.notice}
              </p>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="webhook-url">URL à communiquer au fournisseur (méthode {view.data.method})</Label>
              <div className="flex gap-2">
                <Input id="webhook-url" readOnly value={view.data.url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" size="sm" onClick={() => void copyText(view.data.url, 'URL')} aria-label="Copier l’URL de réception">
                  <Copy className="size-4" /> Copier
                </Button>
              </div>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Signature</dt>
                <dd>
                  HMAC-SHA256 de <code className="rounded bg-muted px-1 text-xs">{view.data.signedContent}</code>, en-tête <code className="rounded bg-muted px-1 text-xs">{view.data.signatureHeader}: sha256=&lt;hex&gt;</code>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Horodatage signé</dt>
                <dd>
                  En-tête <code className="rounded bg-muted px-1 text-xs">{view.data.timestampHeader}</code> (secondes Unix UTC), tolérance ± {view.data.toleranceSeconds} s
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Format</dt>
                <dd>
                  JSON version {view.data.formatVersion}, {Math.round(view.data.maxBodyBytes / 1024)} Kio au plus, {view.data.maxSamplesPerList} éléments au plus par liste (docs/connecteur-telematique.md)
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Débit</dt>
                <dd>{view.data.maxRequestsPerMinute} lot(s) par minute au plus (429 au-delà)</dd>
              </div>
            </dl>

            <SecretState secret={view.data.secret} overlapHours={view.data.rotationOverlapHours} timezone={session.timezone} />
            {!closed ? (
              <Button type="button" size="sm" variant={view.data.secret.configured ? 'outline' : 'default'} onClick={() => setGenerating(true)}>
                <KeyRound className="size-4" /> {view.data.secret.configured ? 'Générer un nouveau secret (rotation)' : 'Générer le secret de signature'}
              </Button>
            ) : null}

            <div className="grid gap-2 text-sm sm:grid-cols-5">
              <Counter label="En attente" value={view.data.counts.pending} />
              <Counter label="Reçus (24 h)" value={view.data.counts.receivedLast24h} />
              <Counter label="Ingérés (24 h)" value={view.data.counts.processedLast24h} />
              <Counter label="Ignorés (24 h)" value={view.data.counts.ignoredLast24h} />
              <Counter label="En échec (24 h)" value={view.data.counts.failedLast24h} />
            </div>
            {view.data.recent.length === 0 ? (
              <EmptyState title="Aucun lot reçu" description="Les lots apparaîtront ici dès que le fournisseur enverra des données signées." />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reçu le</TableHead>
                      <TableHead>État</TableHead>
                      <TableHead className="hidden md:table-cell">Contenu</TableHead>
                      <TableHead className="hidden lg:table-cell">Tentatives</TableHead>
                      <TableHead>Motif</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.data.recent.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(d.receivedAt, session.timezone)}</TableCell>
                        <TableCell>
                          <StatusBadge label={WEBHOOK_DELIVERY_STATUS_LABELS[d.status]} tone={deliveryTone(d.status)} />
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {d.units} unité(s), {d.odometers} kilométrage(s), {d.fuel} carburant ({Math.max(1, Math.round(d.sizeBytes / 1024))} Kio)
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">{d.attempts}</TableCell>
                        <TableCell className="max-w-xs break-words text-xs">{d.lastError ?? (d.processedAt ? `Traité le ${formatDateTime(d.processedAt, session.timezone)}` : '—')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
      {generating && view.data ? <GenerateSecretDialog providerId={provider.id} rotating={view.data.secret.configured} overlapHours={view.data.rotationOverlapHours} onClose={() => setGenerating(false)} /> : null}
    </Card>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function SecretState({ secret, overlapHours, timezone }: { secret: CredentialStatus; overlapHours: number; timezone: string }) {
  return (
    <div className="rounded-md border p-3 text-sm">
      <p className="font-medium">Secret de signature</p>
      <p className="text-muted-foreground">
        {secret.configured ? `Configuré le ${formatDateTime(secret.rotatedAt, timezone)} ; jamais réaffiché (chiffré au repos).` : 'Non configuré : tout lot est refusé tant qu’un secret n’est pas généré et communiqué au fournisseur.'}
      </p>
      {secret.previousValidUntil ? (
        <p className="text-muted-foreground">Ancien secret encore accepté jusqu’au {formatDateTime(secret.previousValidUntil, timezone)} (recouvrement de {overlapHours} h).</p>
      ) : null}
    </div>
  );
}

/**
 * Génération du secret dans le navigateur (générateur cryptographique), affiché une seule fois pour être
 * transmis au fournisseur par un canal sûr, puis déposé en écriture seule : l'API ne le renvoie jamais.
 */
function GenerateSecretDialog({ providerId, rotating, overlapHours, onClose }: { providerId: string; rotating: boolean; overlapHours: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState(() => generateWebhookSecret());
  const [transmitted, setTransmitted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const close = () => {
    setSecret('');
    onClose();
  };
  const mutation = useMutation({
    mutationFn: () => api<CredentialStatus>(`/telemetry/providers/${providerId}/credentials/SIGNATURE_WEBHOOK`, { method: 'PUT', body: { secret } }),
    onSuccess: (status) => {
      toast.success(status.previousValidUntil ? 'Nouveau secret enregistré (chiffré) ; l’ancien reste accepté pendant la période de recouvrement.' : 'Secret de signature enregistré (chiffré).');
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
      close();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
      } else toast.error('Enregistrement impossible.');
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && close()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{rotating ? 'Rotation du secret de signature' : 'Secret de signature du webhook'}</DialogTitle>
          <DialogDescription>
            Copiez ce secret et transmettez-le au fournisseur par un canal sûr : il ne sera plus jamais affiché.
            {rotating ? ` L’ancien secret reste accepté pendant ${overlapHours} h après l’enregistrement, le temps que le fournisseur bascule.` : ''}
          </DialogDescription>
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
            <Label htmlFor="webhook-secret">Secret généré</Label>
            <div className="flex gap-2">
              <Input id="webhook-secret" readOnly value={secret} className="font-mono text-xs" spellCheck={false} autoComplete="off" onFocus={(e) => e.currentTarget.select()} aria-describedby="secret-error" />
              <Button type="button" variant="outline" size="sm" onClick={() => void copyText(secret, 'Secret')} aria-label="Copier le secret">
                <Copy className="size-4" /> Copier
              </Button>
            </div>
            <FieldError errors={fieldErrors} name="secret" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setSecret(generateWebhookSecret())} disabled={mutation.isPending}>
              Générer une autre valeur
            </Button>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="webhook-transmitted" checked={transmitted} onCheckedChange={(v) => setTransmitted(v === true)} />
            <Label htmlFor="webhook-transmitted" className="font-normal">
              J’ai copié ce secret pour le transmettre au fournisseur.
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={close}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending || !transmitted || secret.length === 0}>
              {mutation.isPending ? 'Chiffrement…' : 'Enregistrer le secret'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
