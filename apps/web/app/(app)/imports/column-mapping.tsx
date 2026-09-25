'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { ImportBatchView, ImportModel } from '@/lib/imports-types';

/** Association envoyée à l'API : les colonnes laissées « non associées » sont omises. */
function compact(mapping: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping).filter(([, header]) => header !== ''));
}

/** Vrai si l'association affichée est celle que l'API a retenue au dernier contrôle. */
export function isSameMapping(local: Record<string, string>, saved: Record<string, string> | null): boolean {
  const entries = Object.entries(compact(local));
  const reference = saved ?? {};
  return entries.length === Object.keys(reference).length && entries.every(([column, header]) => reference[column] === header);
}

/**
 * Étape 3 : association colonne du modèle → en-tête du fichier, pré-remplie par l'API (en-têtes
 * identiques aux noms de colonnes), puis contrôle de toutes les lignes sans rien écrire
 * (POST /imports/:id/validate). Les refus d'association reviennent par colonne (fieldErrors).
 */
export function ColumnMappingForm({
  batch,
  model,
  mapping,
  onChange,
  disabled,
  onValidated,
}: {
  batch: ImportBatchView;
  model: ImportModel;
  mapping: Record<string, string>;
  onChange: (mapping: Record<string, string>) => void;
  disabled: boolean;
  onValidated: () => void;
}) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const headers = batch.headers.filter((h) => h !== '');
  const used = new Set(Object.values(mapping).filter((h) => h !== ''));
  const unused = headers.filter((h) => !used.has(h));

  const validate = useMutation({
    mutationKey: ['import-validate', batch.id],
    mutationFn: () => api<ImportBatchView>(`/imports/${batch.id}/validate`, { method: 'POST', body: { mapping: compact(mapping), expectedVersion: batch.version } }),
    onSuccess: (updated) => {
      onValidated();
      const counts = updated.counts;
      if (counts && counts.errors > 0) toast.warning(`Contrôle terminé : ${counts.errors} ligne(s) en erreur sur ${counts.total}.`);
      else toast.success(`Contrôle terminé : ${counts?.valid ?? 0} ligne(s) prête(s) à importer.`);
      void queryClient.invalidateQueries({ queryKey: ['import-rows', updated.id] });
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
      queryClient.setQueryData(['import', updated.id], updated);
    },
    onError: (error) => {
      if (!isApiError(error)) return;
      setFieldErrors(error.fieldErrors);
      // Lot modifié, confirmé ou abandonné entre-temps : données rechargées.
      if (error.status === 409 || error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: ['import', batch.id] });
        void queryClient.invalidateQueries({ queryKey: ['imports'] });
      }
    },
  });

  return (
    <section aria-labelledby="import-mapping-title" className="space-y-4 rounded-lg border p-4">
      <div>
        <h2 id="import-mapping-title" className="text-lg font-semibold">
          3. Associer les colonnes
        </h2>
        <p className="text-sm text-muted-foreground">
          Pour chaque colonne du modèle, choisissez l’en-tête correspondant dans votre fichier. Les colonnes marquées * sont obligatoires ; une colonne facultative non associée reste vide.
        </p>
      </div>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setFieldErrors({});
          validate.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {model.columns.map((c) => {
            const id = `import-map-${c.name}`;
            const invalid = Boolean(fieldErrors[c.name]?.length);
            return (
              <div key={c.name} className="space-y-1">
                <Label htmlFor={id} className="font-mono text-xs">
                  {c.name}
                  {c.required ? (
                    <span className="text-destructive">
                      *<span className="sr-only"> (obligatoire)</span>
                    </span>
                  ) : null}
                </Label>
                <NativeSelect
                  id={id}
                  className="w-full"
                  value={mapping[c.name] ?? ''}
                  disabled={disabled || validate.isPending}
                  aria-invalid={invalid ? true : undefined}
                  aria-describedby={[`${id}-hint`, invalid ? `${c.name}-error` : null].filter(Boolean).join(' ')}
                  onChange={(e) => {
                    onChange({ ...mapping, [c.name]: e.target.value });
                    if (fieldErrors[c.name]) {
                      const { [c.name]: _removed, ...rest } = fieldErrors;
                      setFieldErrors(rest);
                    }
                  }}
                >
                  <NativeSelectOption value="">{c.required ? '— À associer —' : '— Non associée —'}</NativeSelectOption>
                  {headers.map((h, i) => (
                    <NativeSelectOption key={`${i}:${h}`} value={h}>
                      {h}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                  {c.description}
                  {c.example ? ` (ex. ${c.example})` : ''}
                </p>
                <FieldError errors={fieldErrors} name={c.name} />
              </div>
            );
          })}
        </div>
        {unused.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            En-têtes du fichier non associés (ignorés) : {unused.map((h) => `« ${h} »`).join(', ')}.
          </p>
        ) : null}
        {validate.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {isApiError(validate.error) ? validate.error.message : 'Contrôle impossible.'}
          </p>
        ) : null}
        <Button type="submit" disabled={disabled || validate.isPending}>
          <ListChecks className="size-4" aria-hidden="true" />
          {validate.isPending ? 'Contrôle en cours… (aucune ligne n’est écrite)' : batch.status === 'CONTROLE' ? 'Relancer le contrôle' : 'Contrôler le fichier'}
        </Button>
      </form>
    </section>
  );
}
