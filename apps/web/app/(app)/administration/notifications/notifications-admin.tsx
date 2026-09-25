'use client';

import { useQuery } from '@tanstack/react-query';
import { MailCheck, MailX } from 'lucide-react';
import Link from 'next/link';
import { ALL } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { OUTBOX_KIND_LABELS, OUTBOX_STATUSES, OUTBOX_STATUS_LABELS, type NotificationStatus, type OutboxEntry, type OutboxKind, type OutboxStatus } from '@/lib/notifications-types';
import { useListParams } from '@/lib/use-list-params';

const PAGE_SIZE = 25;
const KINDS = Object.keys(OUTBOX_KIND_LABELS) as OutboxKind[];

function toneForOutbox(status: OutboxStatus): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'ENVOYE':
      return 'success';
    case 'ECHEC':
      return 'warning';
    case 'ABANDONNE':
      return 'danger';
    case 'EN_COURS':
      return 'info';
    default:
      return 'neutral';
  }
}

/**
 * Supervision des e-mails (CDC 9.4 ; administrateur) : état du canal (GET /notifications/status, sans
 * SMTP « Canal e-mail non configuré ») et outbox persistante (GET /notifications/outbox) avec statut exact,
 * tentatives, prochaine tentative et erreur expurgée par l'API ; le corps des messages n'est jamais exposé.
 */
export function NotificationsAdmin() {
  const { session, companyId } = useAppScope();
  const { get, set, page } = useListParams();
  const status = (OUTBOX_STATUSES as readonly string[]).includes(get('statut')) ? get('statut') : '';
  const kind = (KINDS as string[]).includes(get('type')) ? get('type') : '';
  const q = get('q');
  const channel = useQuery({ queryKey: ['notifications', 'status'], queryFn: () => api<NotificationStatus>('/notifications/status') });
  const listQuery = toQuery({ status, kind, q, page, pageSize: PAGE_SIZE });
  const outbox = useQuery({ queryKey: ['notifications', 'outbox', listQuery], queryFn: () => api<Page<OutboxEntry>>(`/notifications/outbox${listQuery}`) });
  const filtered = Boolean(status || kind || q);
  const companyCode = (id: string | null) => (id ? (session.companies.find((c) => c.id === id)?.code ?? '—') : 'Groupe');

  return (
    <div>
      <PageHeader
        title="Notifications"
        description={`Canal e-mail et file d’envoi de toute l’organisation${companyId ? ' (la société sélectionnée ne filtre pas cette file)' : ''}. Dates et heures du fuseau ${session.timezone}.`}
      />

      <section aria-labelledby="etat-canal" className="mb-6 space-y-3">
        <h2 id="etat-canal" className="sr-only">
          État du canal e-mail
        </h2>
        {channel.isPending ? (
          <LoadingState label="Lecture de l’état du canal…" />
        ) : channel.isError ? (
          <ErrorState error={channel.error} retry={() => void channel.refetch()} />
        ) : (
          <>
            <Alert variant={channel.data.emailChannelConfigured ? 'default' : 'destructive'}>
              {channel.data.emailChannelConfigured ? <MailCheck aria-hidden="true" /> : <MailX aria-hidden="true" />}
              <AlertTitle>{channel.data.message}</AlertTitle>
              <AlertDescription>
                {channel.data.emailChannelConfigured
                  ? 'Les e-mails sont envoyés par le traitement d’envoi, avec reprises automatiques ; les droits du destinataire sont revérifiés avant chaque envoi.'
                  : 'Sans serveur SMTP, aucun e-mail n’est mis en file ni envoyé. Le centre d’alertes fonctionne normalement ; un lien d’accès à usage unique se génère depuis la fiche de l’utilisateur (« Générer un lien d’accès »).'}
              </AlertDescription>
            </Alert>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {OUTBOX_STATUSES.map((s) => (
                <div key={s} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{OUTBOX_STATUS_LABELS[s]}</dt>
                  <dd className="text-2xl font-semibold">{channel.data.outbox[s] ?? 0}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-muted-foreground">
              Plus ancien message en attente : {channel.data.oldestPendingAt ? formatDateTime(channel.data.oldestPendingAt, session.timezone) : 'aucun'} · dernier envoi réussi :{' '}
              {channel.data.lastSentAt ? formatDateTime(channel.data.lastSentAt, session.timezone) : 'aucun'}.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="file-envoi" className="space-y-3">
        <h2 id="file-envoi" className="text-lg font-semibold">
          File d’envoi
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="filter-statut" className="text-xs text-muted-foreground">
              Statut
            </Label>
            <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
              <SelectTrigger id="filter-statut" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tous les statuts</SelectItem>
                {OUTBOX_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {OUTBOX_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-type" className="text-xs text-muted-foreground">
              Type de message
            </Label>
            <Select value={kind || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
              <SelectTrigger id="filter-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tous les types</SelectItem>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {OUTBOX_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-q" className="text-xs text-muted-foreground">
              Recherche
            </Label>
            <Input id="filter-q" placeholder="Objet ou destinataire" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
          </div>
        </div>

        {outbox.isPending ? (
          <LoadingState label="Chargement de la file d’envoi…" />
        ) : outbox.isError ? (
          <ErrorState error={outbox.error} retry={() => void outbox.refetch()} />
        ) : outbox.data.total === 0 ? (
          <EmptyState
            title="Aucun message"
            description={filtered ? 'Aucun message ne correspond aux filtres.' : channel.data?.emailChannelConfigured === false ? 'Canal e-mail non configuré : aucun message n’a été mis en file.' : 'Aucun e-mail n’a encore été mis en file.'}
          />
        ) : (
          <div className="rounded-md border">
            <Table aria-label="File d’envoi des e-mails">
              <TableHeader>
                <TableRow>
                  <TableHead>Mis en file</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Destinataire</TableHead>
                  <TableHead>Objet</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead className="text-right">Tentatives</TableHead>
                  <TableHead>Prochaine tentative / envoi</TableHead>
                  <TableHead>Dernière erreur</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outbox.data.items.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(m.createdAt, session.timezone)}</TableCell>
                    <TableCell>
                      {OUTBOX_KIND_LABELS[m.kind] ?? m.kind}
                      <span className="block text-xs text-muted-foreground">{companyCode(m.companyId)}</span>
                    </TableCell>
                    <TableCell className="max-w-56">
                      <Link href={`/administration/utilisateurs/${m.recipientUserId}`} className="block truncate underline-offset-4 hover:underline" title={m.recipientEmail}>
                        {m.recipientEmail}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-72">
                      <span className="block truncate" title={m.subject}>
                        {m.subject}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge label={OUTBOX_STATUS_LABELS[m.status] ?? m.status} tone={toneForOutbox(m.status)} />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {m.attempts} / {m.maxAttempts}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {m.sentAt ? `Envoyé le ${formatDateTime(m.sentAt, session.timezone)}` : m.status === 'EN_ATTENTE' || m.status === 'ECHEC' ? formatDateTime(m.nextAttemptAt, session.timezone) : '—'}
                    </TableCell>
                    <TableCell className="max-w-72">
                      {m.lastError ? (
                        <span className="block text-xs break-words text-destructive">{m.lastError}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationControls page={outbox.data.page} pageSize={outbox.data.pageSize} total={outbox.data.total} onPageChange={(p) => set({ page: p })} />
          </div>
        )}
      </section>
    </div>
  );
}
