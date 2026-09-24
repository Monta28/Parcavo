'use client';

import { useQuery } from '@tanstack/react-query';
import { FieldError } from '@/components/forms/field-error';
import { NONE, type FieldErrors, describedBy, invalid } from '@/components/incidents/ops-helpers';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { FollowUpCandidate } from '@/lib/incidents-types';

/**
 * Responsable du suivi (facultatif) : administrateurs, chefs de parc et opérateurs actifs de la société
 * du véhicule, fournis par l'API (GET /incidents/follow-up-candidates, nom seulement). L'API revérifie
 * le choix à l'enregistrement.
 */
export function FollowUpField({
  id,
  companyId,
  value,
  onChange,
  errors,
  currentName,
}: {
  id: string;
  companyId: string | null;
  value: string;
  onChange: (value: string) => void;
  errors: FieldErrors;
  /** Nom du responsable actuellement désigné (modification), affiché s'il n'est plus candidat. */
  currentName?: string | null;
}) {
  const candidates = useQuery({
    queryKey: ['incidents', 'follow-up-candidates', companyId],
    queryFn: () => api<FollowUpCandidate[]>(`/incidents/follow-up-candidates${toQuery({ companyId })}`),
    enabled: Boolean(companyId),
  });
  const items = candidates.data ?? [];
  const known = value === NONE || items.some((u) => u.id === value);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Responsable du suivi</Label>
      <Select value={value} onValueChange={onChange} disabled={!companyId}>
        <SelectTrigger id={id} className="w-full" aria-invalid={invalid(errors, 'followUpUserId')} aria-describedby={describedBy(errors, 'followUpUserId', `${id}-hint`)}>
          <SelectValue placeholder={candidates.isPending && companyId ? 'Chargement…' : 'Aucun'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Aucun responsable désigné</SelectItem>
          {!known ? <SelectItem value={value}>{currentName ? `${currentName} (actuel, plus habilité)` : 'Responsable actuel'}</SelectItem> : null}
          {items.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {companyId ? 'Administrateurs, chefs de parc et opérateurs actifs de la société du véhicule.' : 'Choisissez d’abord le véhicule.'}
        {candidates.isError ? ` Liste indisponible${isApiError(candidates.error) ? ` : ${candidates.error.message}` : '.'}` : ''}
        {candidates.isSuccess && items.length === 0 ? ' Aucun membre du personnel habilité sur cette société.' : ''}
      </p>
      <FieldError errors={errors} name="followUpUserId" />
    </div>
  );
}
