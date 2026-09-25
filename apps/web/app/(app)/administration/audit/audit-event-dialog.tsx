'use client';

import { ExternalLink, ListFilter } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AUDIT_CHANGE_LABELS, auditDiff, formatAuditValue, prettyJson, type AuditChange, type AuditDiffRow } from '@/lib/audit-diff';
import { objectTypeLabel, type AuditEventView } from '@/lib/audit-types';
import { formatDateTime } from '@/lib/format';
import { objectHref } from '@/lib/object-links';
import { cn } from '@/lib/utils';

const CHANGE_TONES: Record<AuditChange, 'info' | 'warning' | 'danger' | 'neutral'> = {
  AJOUTE: 'info',
  MODIFIE: 'warning',
  RETIRE: 'danger',
  INCHANGE: 'neutral',
};

/**
 * Détail d'un événement d'audit (CDC 16.1 ; D-109) : contexte complet et valeurs avant/après telles que
 * renvoyées par GET /audit, déjà expurgées par le serveur (aucun mot de passe, jeton, empreinte ni clé).
 */
export function AuditEventDialog({
  event,
  timezone,
  isAdmin,
  onClose,
  onFilterObject,
}: {
  event: AuditEventView | null;
  timezone: string;
  isAdmin: boolean;
  onClose: () => void;
  onFilterObject: (event: AuditEventView) => void;
}) {
  return (
    <Dialog open={event !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" showCloseButton={false}>
        {event ? <EventContent event={event} timezone={timezone} isAdmin={isAdmin} onFilterObject={onFilterObject} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EventContent({ event, timezone, isAdmin, onFilterObject }: { event: AuditEventView; timezone: string; isAdmin: boolean; onFilterObject: (event: AuditEventView) => void }) {
  const href = objectHref(event.objectType, event.objectId, { isAdmin });
  const rows = auditDiff(event.before, event.after);
  const before = prettyJson(event.before);
  const after = prettyJson(event.after);
  const hasValues = before !== null || after !== null;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="break-all font-mono text-base">{event.action}</DialogTitle>
        <DialogDescription>
          {formatDateTime(event.createdAt, timezone)} · {event.actorName}
        </DialogDescription>
      </DialogHeader>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="Date et heure">{formatDateTime(event.createdAt, timezone)}</Field>
        <Field label="Acteur">
          {event.actorName}
          <span className="ml-1 text-xs text-muted-foreground">({event.actorType === 'SYSTEME' ? 'traitement système' : 'utilisateur'})</span>
        </Field>
        <Field label="Objet">
          <span>{objectTypeLabel(event.objectType)}</span>
          <span className="ml-1 text-xs text-muted-foreground">({event.objectType})</span>
          {event.objectId ? <span className="block break-all font-mono text-xs">{event.objectId}</span> : null}
          {href ? (
            <Link href={href} className="mt-1 inline-flex items-center gap-1 text-xs underline underline-offset-4">
              <ExternalLink className="size-3" aria-hidden="true" /> Ouvrir la fiche
            </Link>
          ) : null}
        </Field>
        <Field label="Société">{event.companyCode ?? (event.companyId ? '—' : 'Organisation (niveau groupe)')}</Field>
        <Field label="Motif" wide>
          {event.reason ? <span className="whitespace-pre-wrap">{event.reason}</span> : <span className="text-muted-foreground">Aucun motif saisi</span>}
        </Field>
        <Field label="Identifiant de requête">{event.requestId ? <span className="break-all font-mono text-xs">{event.requestId}</span> : '—'}</Field>
        <Field label="Adresse IP">{event.ipAddress ? <span className="font-mono text-xs">{event.ipAddress}</span> : '—'}</Field>
      </dl>

      <section aria-labelledby="audit-values-title" className="space-y-3">
        <div>
          <h3 id="audit-values-title" className="text-sm font-semibold">
            Valeurs avant / après
          </h3>
          <p className="text-xs text-muted-foreground">Valeurs expurgées par le serveur : mots de passe, jetons, empreintes et clés n’apparaissent jamais.</p>
        </div>
        {!hasValues ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Aucune valeur avant/après n’est enregistrée pour cet événement.</p>
        ) : (
          <>
            {rows && rows.length > 0 ? <DiffTable rows={rows} /> : null}
            {rows ? (
              <details className="rounded-md border">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">JSON complet</summary>
                <JsonColumns before={before} after={after} />
              </details>
            ) : (
              <JsonColumns before={before} after={after} />
            )}
          </>
        )}
      </section>

      <DialogFooter>
        {event.objectId ? (
          <Button type="button" variant="outline" onClick={() => onFilterObject(event)}>
            <ListFilter className="size-4" aria-hidden="true" /> Tous les événements de cet objet
          </Button>
        ) : null}
        <DialogClose asChild>
          <Button type="button">Fermer</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function DiffTable({ rows }: { rows: AuditDiffRow[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Champ</TableHead>
            <TableHead>Avant</TableHead>
            <TableHead>Après</TableHead>
            <TableHead>Changement</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key} className={cn(row.change === 'INCHANGE' && 'text-muted-foreground')}>
              <TableCell className="align-top font-mono text-xs">{row.key}</TableCell>
              <TableCell className="max-w-xs align-top">
                <Value present={row.hasBefore} value={row.before} />
              </TableCell>
              <TableCell className="max-w-xs align-top">
                <Value present={row.hasAfter} value={row.after} />
              </TableCell>
              <TableCell className="align-top">
                <StatusBadge label={AUDIT_CHANGE_LABELS[row.change]} tone={CHANGE_TONES[row.change]} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Value({ present, value }: { present: boolean; value: unknown }) {
  if (!present) return <span className="text-xs italic text-muted-foreground">absent</span>;
  return <pre className="whitespace-pre-wrap break-all font-mono text-xs">{formatAuditValue(value)}</pre>;
}

function JsonColumns({ before, after }: { before: string | null; after: string | null }) {
  return (
    <div className="grid gap-3 p-3 md:grid-cols-2">
      <JsonBlock title="Avant" json={before} />
      <JsonBlock title="Après" json={after} />
    </div>
  );
}

function JsonBlock({ title, json }: { title: string; json: string | null }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {json === null ? (
        <p className="rounded-md bg-muted p-3 text-xs italic text-muted-foreground">Aucune valeur</p>
      ) : (
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{json}</pre>
      )}
    </div>
  );
}
