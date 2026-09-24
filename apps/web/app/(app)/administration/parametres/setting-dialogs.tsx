'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import {
  boundsHint,
  descriptorOf,
  expectedVersionFor,
  formatSettingValue,
  historyForScope,
  inputToSettingValue,
  settingToInput,
  type EffectiveSetting,
  type SettingVersion,
} from '@/lib/settings-admin';

interface ScopeProps {
  setting: EffectiveSetting;
  /** Société dont on modifie la surcharge ; null pour la valeur groupe. */
  companyId: string | null;
  companyLabel: string | null;
  onOpenChange: (open: boolean) => void;
}

/** Erreurs de l'API : messages par champ sous les champs, message général en tête du formulaire. */
function useApiErrors() {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  return {
    fieldErrors,
    formError,
    reset: () => {
      setFieldErrors({});
      setFormError(null);
    },
    show: (error: unknown) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        setFormError(error.message);
      } else {
        setFormError('Enregistrement impossible.');
      }
    },
  };
}

/**
 * Nouvelle version d'un paramètre (PUT /settings/:key) : valeur, motif obligatoire, version attendue du
 * niveau modifié (verrou optimiste). La validation (type, bornes, surcharge autorisée) est celle de l'API.
 */
export function SettingEditDialog({ setting, companyId, companyLabel, onOpenChange }: ScopeProps) {
  const queryClient = useQueryClient();
  const descriptor = descriptorOf(setting.key);
  const kind = descriptor?.kind;
  const [text, setText] = useState(() => settingToInput(setting.key, setting.value));
  const [reason, setReason] = useState('');
  const errors = useApiErrors();
  const hint = boundsHint(setting.key);

  const save = useMutation({
    mutationFn: () =>
      api<EffectiveSetting>(`/settings/${encodeURIComponent(setting.key)}`, {
        method: 'PUT',
        body: {
          value: inputToSettingValue(setting.key, text),
          ...(companyId ? { companyId } : {}),
          reason: reason.trim(),
          expectedVersion: expectedVersionFor(setting, companyId),
        },
      }),
    onSuccess: (saved) => {
      toast.success(`${saved.label} : version ${saved.settingVersion ?? '—'} enregistrée.`);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      onOpenChange(false);
    },
    onError: (error) => {
      errors.show(error);
      if (isApiError(error) && error.status === 409) void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{companyId && setting.source !== 'societe' ? 'Surcharger pour une société' : 'Modifier un paramètre'}</DialogTitle>
          <DialogDescription>
            {setting.label} — {companyId ? `surcharge pour ${companyLabel ?? 'la société'}` : 'valeur groupe, appliquée aux sociétés sans surcharge'}. Une nouvelle version est créée ; l’ancienne est conservée et la
            modification est journalisée.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            errors.reset();
            save.mutate();
          }}
        >
          {errors.formError ? (
            <Alert variant="destructive">
              <AlertDescription>{errors.formError}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-sm">
            Valeur actuelle : <span className="font-medium">{formatSettingValue(setting.key, setting.value)}</span>
          </p>
          <div className="space-y-2">
            <Label htmlFor="setting-value">Nouvelle valeur{descriptor?.unit ? ` (${descriptor.unit})` : ''} *</Label>
            {kind === 'boolean' ? (
              <Select value={text} onValueChange={setText}>
                <SelectTrigger id="setting-value" className="w-full" aria-invalid={errors.fieldErrors.value ? true : undefined} aria-describedby="setting-value-hint value-error">
                  <SelectValue placeholder="Choisir" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Oui</SelectItem>
                  <SelectItem value="false">Non</SelectItem>
                </SelectContent>
              </Select>
            ) : kind === 'string-list' ? (
              <Textarea id="setting-value" rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={errors.fieldErrors.value ? true : undefined} aria-describedby="setting-value-hint value-error" />
            ) : (
              <Input
                id="setting-value"
                type={kind === 'time' ? 'time' : 'text'}
                inputMode={kind === 'integer' ? 'numeric' : kind === 'number' ? 'decimal' : undefined}
                autoComplete="off"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-invalid={errors.fieldErrors.value ? true : undefined}
                aria-describedby="setting-value-hint value-error"
              />
            )}
            {hint ? (
              <p id="setting-value-hint" className="text-xs text-muted-foreground">
                {hint}
              </p>
            ) : null}
            <FieldError errors={errors.fieldErrors} name="value" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="setting-reason">Motif *</Label>
            <Textarea
              id="setting-reason"
              rows={3}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={errors.fieldErrors.reason ? true : undefined}
              aria-describedby="setting-reason-hint reason-error"
            />
            <p id="setting-reason-hint" className="text-xs text-muted-foreground">
              De 3 à 500 caractères, conservé dans l’historique et le journal d’audit.
            </p>
            <FieldError errors={errors.fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer la nouvelle version'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Retrait motivé d'une surcharge société (DELETE /settings/:key/override) : retour à la valeur groupe. */
export function ClearOverrideDialog({ setting, companyId, companyLabel, onOpenChange }: ScopeProps & { companyId: string }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const errors = useApiErrors();
  const clear = useMutation({
    mutationFn: () =>
      api<{ ok: true }>(`/settings/${encodeURIComponent(setting.key)}/override`, {
        method: 'DELETE',
        body: { companyId, reason: reason.trim(), ...(setting.settingVersion !== null ? { expectedVersion: setting.settingVersion } : {}) },
      }),
    onSuccess: () => {
      toast.success(`Surcharge retirée : la valeur groupe s’applique de nouveau à ${companyLabel ?? 'la société'}.`);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      onOpenChange(false);
    },
    onError: (error) => {
      errors.show(error);
      if (isApiError(error) && (error.status === 409 || error.status === 404)) void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Retirer la surcharge</DialogTitle>
          <DialogDescription>
            {setting.label} — {companyLabel ?? 'la société'} reprendra la valeur groupe (ou, à défaut, la valeur par défaut du produit). La surcharge reste visible dans l’historique.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            errors.reset();
            clear.mutate();
          }}
        >
          {errors.formError ? (
            <Alert variant="destructive">
              <AlertDescription>{errors.formError}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-sm">
            Surcharge actuelle : <span className="font-medium">{formatSettingValue(setting.key, setting.value)}</span>
          </p>
          <div className="space-y-2">
            <Label htmlFor="clear-reason">Motif *</Label>
            <Textarea id="clear-reason" rows={3} required value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={errors.fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
            <FieldError errors={errors.fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={clear.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={clear.isPending}>
              {clear.isPending ? 'Retrait…' : 'Retirer la surcharge'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Historique des versions (GET /settings/:key/history) : valeur, motif, auteur et date de chaque version. */
export function SettingHistoryDialog({ setting, companyId, companyLabel, onOpenChange }: ScopeProps) {
  const { session } = useAppScope();
  const history = useQuery({
    queryKey: ['settings', 'history', setting.key],
    queryFn: () => api<SettingVersion[]>(`/settings/${encodeURIComponent(setting.key)}/history`),
  });
  const levelOf = (id: string | null) => (id ? (session.companies.find((c) => c.id === id)?.code ?? 'Société') : 'Groupe');
  const rows = history.data ? historyForScope(history.data, companyId) : [];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Historique du paramètre</DialogTitle>
          <DialogDescription>
            {setting.label} — {companyId ? `valeur groupe et surcharges de ${companyLabel ?? 'la société'}` : 'valeur groupe et surcharges de toutes les sociétés'}. Dates et heures du fuseau {session.timezone}.
          </DialogDescription>
        </DialogHeader>
        {history.isPending ? (
          <LoadingState label="Chargement de l’historique…" />
        ) : history.isError ? (
          <ErrorState error={history.error} retry={() => void history.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="Aucune version enregistrée" description="La valeur par défaut du produit s’applique." />
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-md border">
            <Table aria-label={`Historique de ${setting.label}`}>
              <TableHeader>
                <TableRow>
                  <TableHead>Niveau</TableHead>
                  <TableHead className="text-right">Version</TableHead>
                  <TableHead>Valeur</TableHead>
                  <TableHead>État</TableHead>
                  <TableHead>Motif</TableHead>
                  <TableHead>Auteur</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${row.companyId ?? 'groupe'}-${row.settingVersion}`}>
                    <TableCell>{levelOf(row.companyId)}</TableCell>
                    <TableCell className="text-right">{row.settingVersion}</TableCell>
                    <TableCell className="max-w-64 whitespace-normal">{formatSettingValue(setting.key, row.value)}</TableCell>
                    <TableCell>{row.isCurrent ? <StatusBadge label="En vigueur" tone="success" /> : <StatusBadge label="Ancienne version" tone="neutral" />}</TableCell>
                    <TableCell className="max-w-64 whitespace-normal">{row.reason ?? '—'}</TableCell>
                    <TableCell>{row.createdByName ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(row.createdAt, session.timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
