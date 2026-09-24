'use client';

import { useQuery } from '@tanstack/react-query';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { ACCEPTED_SOURCES_LABELS, BASE_MODE_DESCRIPTIONS, BASE_MODE_LABELS, type AcceptedSources, type PlanBaseMode, type UserOption } from '@/lib/maintenance-types';

// --- Base de calcul -------------------------------------------------------------------------------

export interface BaseForm {
  baseMode: PlanBaseMode;
  baseKm: string;
  baseDate: string;
  nextDueKm: string;
  nextDueDate: string;
}

export const EMPTY_BASE: BaseForm = { baseMode: 'DERNIERE_OPERATION', baseKm: '', baseDate: '', nextDueKm: '', nextDueDate: '' };

/** Seuls les champs du mode choisi sont envoyés ; l'API contrôle les valeurs requises. */
export function basePayload(form: BaseForm): Record<string, string> {
  const out: Record<string, string> = { baseMode: form.baseMode };
  const put = (key: keyof BaseForm) => {
    const v = form[key].trim();
    if (v) out[key] = v;
  };
  if (form.baseMode === 'DERNIERE_OPERATION' || form.baseMode === 'BASE_TECHNIQUE') {
    put('baseKm');
    put('baseDate');
  } else if (form.baseMode === 'ECHEANCE_INITIALE') {
    put('nextDueKm');
    put('nextDueDate');
  }
  return out;
}

const BASE_MODES: PlanBaseMode[] = ['DERNIERE_OPERATION', 'BASE_TECHNIQUE', 'ECHEANCE_INITIALE', 'AUCUNE'];

export function BaseFields({ value, onChange, errors, idPrefix }: { value: BaseForm; onChange: (patch: Partial<BaseForm>) => void; errors: Record<string, string[]>; idPrefix: string }) {
  const kmLabel = value.baseMode === 'BASE_TECHNIQUE' ? 'Kilométrage cumulé de la base technique' : 'Kilométrage cumulé de la dernière opération';
  const dateLabel = value.baseMode === 'BASE_TECHNIQUE' ? 'Date de la base technique' : 'Date de la dernière opération';
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Base de calcul</legend>
      <RadioGroup value={value.baseMode} onValueChange={(v) => onChange({ baseMode: v as PlanBaseMode })} aria-describedby="base.baseMode-error">
        {BASE_MODES.map((mode) => (
          <div key={mode} className="flex items-start gap-3">
            <RadioGroupItem id={`${idPrefix}-mode-${mode}`} value={mode} className="mt-0.5" aria-describedby={`${idPrefix}-mode-${mode}-hint`} />
            <div className="space-y-0.5">
              <Label htmlFor={`${idPrefix}-mode-${mode}`}>{BASE_MODE_LABELS[mode]}</Label>
              <p id={`${idPrefix}-mode-${mode}-hint`} className="text-xs text-muted-foreground">
                {BASE_MODE_DESCRIPTIONS[mode]}
              </p>
            </div>
          </div>
        ))}
      </RadioGroup>
      <FieldError errors={errors} name="base.baseMode" />

      {value.baseMode === 'DERNIERE_OPERATION' || value.baseMode === 'BASE_TECHNIQUE' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-baseKm`}>{kmLabel}</Label>
            <Input
              id={`${idPrefix}-baseKm`}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={value.baseKm}
              onChange={(e) => onChange({ baseKm: e.target.value })}
              aria-invalid={errors['base.baseKm'] ? true : undefined}
              aria-describedby="base.baseKm-error"
            />
            <FieldError errors={errors} name="base.baseKm" />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-baseDate`}>{dateLabel}</Label>
            <Input
              id={`${idPrefix}-baseDate`}
              type="date"
              value={value.baseDate}
              onChange={(e) => onChange({ baseDate: e.target.value })}
              aria-invalid={errors['base.baseDate'] ? true : undefined}
              aria-describedby="base.baseDate-error"
            />
            <FieldError errors={errors} name="base.baseDate" />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">Le kilométrage est requis pour un intervalle en km, la date pour un intervalle en temps.</p>
        </div>
      ) : null}

      {value.baseMode === 'ECHEANCE_INITIALE' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-nextDueKm`}>Prochaine échéance (km cumulés)</Label>
            <Input
              id={`${idPrefix}-nextDueKm`}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={value.nextDueKm}
              onChange={(e) => onChange({ nextDueKm: e.target.value })}
              aria-invalid={errors['base.nextDueKm'] ? true : undefined}
              aria-describedby="base.nextDueKm-error"
            />
            <FieldError errors={errors} name="base.nextDueKm" />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-nextDueDate`}>Prochaine échéance (date)</Label>
            <Input
              id={`${idPrefix}-nextDueDate`}
              type="date"
              value={value.nextDueDate}
              onChange={(e) => onChange({ nextDueDate: e.target.value })}
              aria-invalid={errors['base.nextDueDate'] ? true : undefined}
              aria-describedby="base.nextDueDate-error"
            />
            <FieldError errors={errors} name="base.nextDueDate" />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">Renseignez le kilométrage, la date, ou les deux.</p>
        </div>
      ) : null}

      {value.baseMode === 'AUCUNE' ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">Le plan sera enregistré INCOMPLET avec une alerte. Aucune fausse opération à zéro kilomètre n’est créée.</p>
      ) : null}
    </fieldset>
  );
}

// --- Sources de relevés admises -----------------------------------------------------------------

export function SourcesField({ id, value, onChange, errors }: { id: string; value: AcceptedSources; onChange: (v: AcceptedSources) => void; errors: Record<string, string[]> }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Relevés admis pour le calcul</Label>
      <Select value={value} onValueChange={(v) => onChange(v as AcceptedSources)}>
        <SelectTrigger id={id} className="w-full" aria-invalid={errors.acceptedSources ? true : undefined} aria-describedby="acceptedSources-error">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ACCEPTED_SOURCES_LABELS) as AcceptedSources[]).map((k) => (
            <SelectItem key={k} value={k}>
              {ACCEPTED_SOURCES_LABELS[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError errors={errors} name="acceptedSources" />
    </div>
  );
}

// --- Responsable ------------------------------------------------------------------------------------

export const RESPONSIBLE_NONE = '__aucun__';

/** Utilisateurs actifs (GET /users, réservé à l'administrateur) pour choisir un responsable. */
export function useUserOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['users', 'options'],
    queryFn: () => api<Page<UserOption>>(`/users${toQuery({ status: 'ACTIF', pageSize: 100, sort: 'lastName' })}`),
    enabled,
    staleTime: 60_000,
  });
}

/** Valeur envoyée à l'API : null pour « aucun responsable ». */
export function responsiblePayload(value: string): string | null {
  return value === RESPONSIBLE_NONE ? null : value;
}

/**
 * Responsable du plan. L'administrateur choisit parmi les utilisateurs actifs ; un chef de parc peut se
 * désigner, retirer le responsable ou conserver le responsable actuel (la liste des comptes est réservée
 * à l'administrateur).
 */
export function ResponsibleField({
  id,
  value,
  onChange,
  current,
  currentName,
  errors,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  current?: string | null;
  /** Nom du responsable actuel renvoyé par l'API (PlanViewDto.responsibleUserName). */
  currentName?: string | null;
  errors: Record<string, string[]>;
}) {
  const session = useSession();
  const users = useUserOptions(session.isAdmin);
  const others = (users.data?.items ?? []).filter((u) => u.id !== session.userId);
  const keepCurrent = current && current !== session.userId && !others.some((u) => u.id === current) ? current : null;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Responsable</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full" aria-invalid={errors.responsibleUserId ? true : undefined} aria-describedby="responsibleUserId-error">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {keepCurrent ? <SelectItem value={keepCurrent}>{currentName ? `${currentName} (responsable actuel)` : 'Responsable actuel (inchangé)'}</SelectItem> : null}
          <SelectItem value={RESPONSIBLE_NONE}>Aucun responsable</SelectItem>
          <SelectItem value={session.userId}>
            Moi-même ({session.firstName} {session.lastName})
          </SelectItem>
          {others.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.firstName} {u.lastName} · {u.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {session.isAdmin && users.isError ? <p className="text-xs text-destructive">Liste des utilisateurs indisponible : seuls « aucun » et « moi-même » sont proposés.</p> : null}
      <p className="text-xs text-muted-foreground">Compte actif habilité (administrateur, chef de parc ou opérateur) sur la société du véhicule ; contrôlé par le serveur.</p>
      <FieldError errors={errors} name="responsibleUserId" />
    </div>
  );
}

/** Nom du responsable renvoyé par l'API (responsibleUserName) ; « vous » pour l'utilisateur connecté. */
export function ResponsibleName({ userId, name }: { userId: string | null; name: string | null }) {
  const session = useSession();
  if (!userId) return <span className="text-muted-foreground">Aucun</span>;
  if (userId === session.userId) return <span>Vous ({session.firstName} {session.lastName})</span>;
  return <span>{name ?? 'Compte introuvable'}</span>;
}
