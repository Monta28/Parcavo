'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { AttachmentLink, ReadingStatusBadge } from '@/components/odometer/reading-display';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { formatDateTime, formatKm } from '@/lib/format';
import type { FuelEntryView } from '@/lib/fuel-types';
import { FuelAnomalyBadges, FuelStatusBadge, FuelWarnings, energyLabel, formatFuelLiters, useFuelRights, useMoney } from '../fuel-display';
import { CancelDialog, CapacityDialog, CorrectDialog, RejectDialog, ValidateDialog } from './fuel-dialogs';

type DialogKind = 'validate' | 'reject' | 'cancel' | 'correct' | 'capacity';

const DECISION_LABELS: Record<string, string> = {
  VALIDE: 'Validé le',
  REJETE: 'Rejeté le',
  ANNULE: 'Annulé le',
  REMPLACE: 'Corrigé le',
};

/**
 * Détail d'un plein (CDC 8.2, 10.2) : valeurs saisies, avertissements du serveur, justificatif privé,
 * suivi des décisions et actions permises (valider, rejeter, annuler, corriger, confirmer la capacité).
 * Les boutons ne sont qu'un confort d'affichage : l'API applique droits, états et versions.
 */
export function FuelDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const entry = useQuery({ queryKey: ['fuel-entry', id], queryFn: () => api<FuelEntryView>(`/fuel-entries/${id}`) });
  const rights = useFuelRights(entry.data?.companyId ?? null);
  const money = useMoney();
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  if (entry.isPending) return <LoadingState label="Chargement du plein…" />;
  if (entry.isError) return <ErrorState error={entry.error} retry={() => void entry.refetch()} />;
  const e = entry.data;
  const companyCode = session.companies.find((c) => c.id === e.companyId)?.code ?? '—';
  const canValidate = e.status === 'SOUMIS' && rights.decide;
  const canCorrect = e.status === 'VALIDE' && rights.manager && rights.write;
  const canConfirmCapacity = e.tankCapacityExceeded && !e.capacityConfirmedAt && (e.status === 'SOUMIS' || e.status === 'VALIDE') && rights.manager;
  const canApproveReading = e.readingStatus === 'EN_ATTENTE' && (session.isAdmin || session.grants.some((g) => g.companyId === e.companyId && g.permissions.includes('readings.approve')));

  return (
    <div>
      <PageHeader
        title={`Plein du ${formatDateTime(e.filledAt, session.timezone)}`}
        description={`${e.vehicleCode} · ${e.vehicleRegistration} · Société ${companyCode}`}
        actions={
          <>
            <Button variant="outline" asChild>
              {session.isDriverOnly ? <Link href="/mon-vehicule">Mon véhicule</Link> : <Link href="/carburant">Tous les pleins</Link>}
            </Button>
            {canValidate ? <Button onClick={() => setDialog('validate')}>Valider</Button> : null}
            {canValidate ? (
              <Button variant="outline" onClick={() => setDialog('reject')}>
                Rejeter
              </Button>
            ) : null}
            {canConfirmCapacity ? (
              <Button variant="outline" onClick={() => setDialog('capacity')}>
                Confirmer la capacité
              </Button>
            ) : null}
            {canCorrect ? (
              <Button variant="outline" onClick={() => setDialog('correct')}>
                Corriger
              </Button>
            ) : null}
            {canCorrect ? (
              <Button variant="outline" onClick={() => setDialog('cancel')}>
                Annuler le plein
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FuelStatusBadge status={e.status} />
        <FuelAnomalyBadges entry={e} />
      </div>

      <div className="space-y-4">
        <StatusNotice entry={e} />
        <FuelWarnings entry={e} money={money} />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Plein</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <Item label="Date et heure">{formatDateTime(e.filledAt, session.timezone)}</Item>
                <Item label="Véhicule">
                  <Link href={`/vehicules/${e.vehicleId}`} className="underline underline-offset-4">
                    {e.vehicleCode} · {e.vehicleRegistration}
                  </Link>
                </Item>
                <Item label="Conducteur">
                  {e.driverId && e.driverName && !session.isDriverOnly ? (
                    <Link href={`/conducteurs/${e.driverId}`} className="underline underline-offset-4">
                      {e.driverName}
                    </Link>
                  ) : (
                    (e.driverName ?? '—')
                  )}
                </Item>
                <Item label="Station / fournisseur">{e.supplierName ?? '—'}</Item>
                <Item label="Carburant">{energyLabel(e.energy)}</Item>
                <Item label="Type de plein">{e.isFullTank ? 'Plein complet' : 'Plein partiel'}</Item>
                <Item label="Litres">{formatFuelLiters(e.liters)}</Item>
                {rights.readCosts || e.totalAmount !== null ? (
                  <>
                    <Item label="Prix unitaire TTC">{e.unitPrice === null ? (e.totalAmount === null ? 'Non communiqué' : 'Non saisi') : money(e.unitPrice)}</Item>
                    <Item label="Montant total TTC">{e.totalAmount === null ? 'Non communiqué' : money(e.totalAmount)}</Item>
                  </>
                ) : (
                  <Item label="Montants">Consultation réservée aux titulaires de la permission « Consulter les coûts ».</Item>
                )}
                <Item label="Compteur déclaré">{e.declaredPhysicalKm ? formatKm(e.declaredPhysicalKm) : 'Non renseigné'}</Item>
                <Item label="Relevé du compteur">
                  {e.readingStatus ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <ReadingStatusBadge status={e.readingStatus} />
                      {canApproveReading ? (
                        <Link href={`/kilometrage?onglet=a-valider&vehicule=${encodeURIComponent(e.vehicleId)}`} className="underline underline-offset-4">
                          Valider le relevé
                        </Link>
                      ) : null}
                    </span>
                  ) : (
                    'Aucun relevé lié'
                  )}
                  {e.readingStatusReason ? <span className="mt-1 block text-muted-foreground">{e.readingStatusReason}</span> : null}
                </Item>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Consommation</dt>
                  <dd>{e.consumptionEligibilityLabel}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Remarques</dt>
                  <dd className="whitespace-pre-wrap">{e.notes ?? '—'}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Justificatif</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {!e.ticketAttachmentId ? (
                  <p className="text-muted-foreground">Aucun ticket joint.</p>
                ) : rights.readCosts || session.isDriverOnly ? (
                  // Conducteur : l'API ne renvoie que ses propres déclarations et l'autorise à relire leur ticket (D-226).
                  <AttachmentLink id={e.ticketAttachmentId} label="Ouvrir le ticket" />
                ) : (
                  <p className="text-muted-foreground">Ticket joint : consultation réservée aux titulaires de la permission « Consulter les coûts ».</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Suivi</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3 text-sm">
                  {e.replacesFuelEntryId ? (
                    <li>
                      <span className="text-muted-foreground">Correction de </span>
                      <Link href={`/carburant/${e.replacesFuelEntryId}`} className="underline underline-offset-4">
                        la version précédente du plein
                      </Link>
                    </li>
                  ) : null}
                  <li>
                    <span className="text-muted-foreground">Enregistré le </span>
                    {formatDateTime(e.createdAt, session.timezone)}
                  </li>
                  {e.decidedAt ? (
                    <li>
                      <span className="text-muted-foreground">{DECISION_LABELS[e.status] ?? 'Décision le'} </span>
                      {formatDateTime(e.decidedAt, session.timezone)}
                      {e.decisionReason ? <span className="block">Motif : {e.decisionReason}</span> : null}
                    </li>
                  ) : null}
                  {e.capacityConfirmedAt ? (
                    <li>
                      <span className="text-muted-foreground">Capacité confirmée le </span>
                      {formatDateTime(e.capacityConfirmedAt, session.timezone)}
                    </li>
                  ) : null}
                  {e.replacedByFuelEntryId ? (
                    <li>
                      <span className="text-muted-foreground">Remplacé par </span>
                      <Link href={`/carburant/${e.replacedByFuelEntryId}`} className="underline underline-offset-4">
                        la version corrigée
                      </Link>
                    </li>
                  ) : null}
                  {e.expenseId ? (
                    <li>
                      <span className="text-muted-foreground">Dépense de synthèse active : </span>
                      <Link href={`/depenses/${encodeURIComponent(e.expenseId)}`} className="underline underline-offset-4">
                        Dépense de synthèse
                      </Link>
                      <span className="text-muted-foreground"> · </span>
                      <Link href={`/depenses?vehicule=${encodeURIComponent(e.vehicleId)}&source=PLEIN`} className="underline underline-offset-4">
                        voir au registre des dépenses
                      </Link>
                    </li>
                  ) : null}
                </ol>
                {rights.manager ? (
                  <p className="mt-4 text-sm">
                    <Link href={`/administration/audit?type=FuelEntry&objet=${encodeURIComponent(e.id)}`} className="underline underline-offset-4">
                      Journal d’audit de ce plein
                    </Link>
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {dialog === 'validate' ? <ValidateDialog entry={e} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'reject' ? <RejectDialog entry={e} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'cancel' ? <CancelDialog entry={e} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'correct' ? <CorrectDialog entry={e} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'capacity' ? <CapacityDialog entry={e} onOpenChange={(o) => !o && setDialog(null)} /> : null}
    </div>
  );
}

/** Explication du statut fourni par l'API. */
function StatusNotice({ entry: e }: { entry: FuelEntryView }) {
  switch (e.status) {
    case 'SOUMIS':
      return <p className="rounded-md border p-3 text-sm">Ticket soumis par le conducteur, en attente de validation : aucune dépense n’est enregistrée avant la validation.</p>;
    case 'REJETE':
      return (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          Soumission rejetée{e.decisionReason ? ` : ${e.decisionReason}` : ''}.
        </p>
      );
    case 'ANNULE':
      return (
        <p className="rounded-md border p-3 text-sm">
          Plein annulé{e.decisionReason ? ` : ${e.decisionReason}` : ''}.
        </p>
      );
    case 'REMPLACE':
      return (
        <p className="rounded-md border p-3 text-sm">
          Cette version a été corrigée
          {e.replacedByFuelEntryId ? (
            <>
              {' '}
              :{' '}
              <Link href={`/carburant/${e.replacedByFuelEntryId}`} className="underline underline-offset-4">
                ouvrir la version corrigée
              </Link>
            </>
          ) : null}
          .
        </p>
      );
    default:
      return null;
  }
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
