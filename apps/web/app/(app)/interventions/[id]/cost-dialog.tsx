'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDate } from '@/lib/format';
import type { InterventionView } from '@/lib/interventions-types';
import { ApiErrorAlert, AttachmentsField, CostFields, type CostState, GarageSelect, type UploadedFile, costPayload, newCostLineRow, validateCost } from '../form-parts';
import { type FieldErrors, NONE } from '../intervention-helpers';
import { useInterventionCache } from './action-dialogs';

/**
 * Saisir le coût d'une intervention terminée « coût à saisir » (POST :id/cost, costs.write) : crée
 * l'unique dépense liée, sauf « sans coût ». Total et montants de ligne calculés par l'API.
 */
export function CostDialog({ intervention, onOpenChange }: { intervention: InterventionView; onOpenChange: (open: boolean) => void }) {
  const cache = useInterventionCache(intervention.id);
  const [cost, setCost] = useState<CostState>(() => ({ mode: 'lignes', lines: [newCostLineRow('PIECE')], total: '' }));
  const [supplierId, setSupplierId] = useState(intervention.supplierId ?? NONE);
  const [invoice, setInvoice] = useState<UploadedFile[]>([]);
  const [local, setLocal] = useState<FieldErrors>({});

  const record = useMutation({
    mutationFn: () =>
      api<InterventionView>(`/interventions/${intervention.id}/cost`, {
        method: 'POST',
        body: {
          ...costPayload(cost),
          supplierId: supplierId !== NONE && supplierId !== intervention.supplierId ? supplierId : undefined,
          // Toujours transmise : une facture jointe à « sans coût » ou à un total nul est refusée par l'API
          // (422 FACTURE_SANS_COUT sur le champ), jamais retirée en silence.
          invoiceAttachmentId: invoice[0] ? invoice[0].id : undefined,
          expectedVersion: intervention.version,
        },
      }),
    onSuccess: (updated) => {
      cache.saved(updated, updated.costStatus === 'SANS_COUT' ? `Intervention ${updated.reference} déclarée sans coût.` : `Coût de l’intervention ${updated.reference} enregistré ; la dépense liée est créée.`);
      onOpenChange(false);
    },
    onError: (error) => cache.failed(error, 'Enregistrement du coût impossible.'),
  });
  const apiErrors = isApiError(record.error) ? record.error.fieldErrors : {};
  const errors = { ...apiErrors, ...local };

  return (
    <Dialog open onOpenChange={(o) => !record.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Saisir le coût de l’intervention {intervention.reference}</DialogTitle>
          <DialogDescription>
            La dépense liée (catégorie entretien / réparation) est créée à la date effective {intervention.performedOn ? `du ${formatDate(intervention.performedOn)}` : 'de réalisation'}, pour la société historique de l’intervention.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next = validateCost(cost);
            setLocal(next);
            if (Object.keys(next).length === 0) record.mutate();
          }}
        >
          <CostFields idPrefix="cost" state={cost} onChange={setCost} canWriteCosts allowLater={false} tasks={intervention.tasks} errors={errors} />
          <GarageSelect
            id="cost-supplier"
            companyId={intervention.companyId}
            value={supplierId}
            onChange={setSupplierId}
            current={intervention.supplierId && intervention.supplierName ? { id: intervention.supplierId, name: intervention.supplierName } : null}
            allowNone={!intervention.supplierId}
            errors={errors}
          />
          <AttachmentsField
            id="cost-invoice"
            label="Facture (facultatif)"
            hint="PDF, JPEG ou PNG, 10 Mo maximum ; rattachée à la dépense créée. Une facture exige un coût non nul : avec « sans coût » ou un total à 0, elle est refusée (retirez-la ou corrigez le montant)."
            companyId={intervention.companyId}
            files={invoice}
            onChange={setInvoice}
            max={1}
            errors={errors}
            errorName="invoiceAttachmentId"
          />
          <ApiErrorAlert error={record.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={record.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={record.isPending}>
              {record.isPending ? 'Enregistrement…' : 'Enregistrer le coût'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
