'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { ImportBatchView, ImportKind, ImportModel } from '@/lib/imports-types';
import { useListParams } from '@/lib/use-list-params';
import { ImportFormatsHelp } from './import-help';

const ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Étapes 1 et 2 : choix du modèle (colonnes, modèle vierge) et téléversement du fichier (POST /imports). */
export function NewImport({ models }: { models: ImportModel[] }) {
  const { get, set } = useListParams();
  const model = models.find((m) => m.kind === get('modele')) ?? null;

  return (
    <div className="space-y-6">
      <section aria-labelledby="import-step-model" className="space-y-4 rounded-lg border p-4">
        <div>
          <h2 id="import-step-model" className="text-lg font-semibold">
            1. Choisir le modèle
          </h2>
          <p className="text-sm text-muted-foreground">Téléchargez le modèle vierge, complétez-le puis envoyez-le. Les en-têtes peuvent différer : vous les associerez ensuite.</p>
        </div>
        <RadioGroup aria-labelledby="import-step-model" value={model?.kind ?? ''} onValueChange={(v) => set({ modele: v })} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {models.map((m) => {
            const required = m.columns.filter((c) => c.required).length;
            return (
              <Label key={m.kind} htmlFor={`import-model-${m.kind}`} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
                <RadioGroupItem id={`import-model-${m.kind}`} value={m.kind} className="mt-0.5" />
                <span>
                  <span className="block font-medium">{m.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {required} colonne{required > 1 ? 's' : ''} obligatoire{required > 1 ? 's' : ''}, {m.columns.length - required} facultative{m.columns.length - required > 1 ? 's' : ''}
                  </span>
                </span>
              </Label>
            );
          })}
        </RadioGroup>
        {model ? <ModelDetail model={model} /> : <p className="text-sm text-muted-foreground">Sélectionnez un modèle pour afficher ses colonnes.</p>}
        <ImportFormatsHelp />
      </section>

      <UploadStep model={model} />
    </div>
  );
}

function ModelDetail({ model }: { model: ImportModel }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={`/api/v1/imports/templates/${model.kind}?format=xlsx`} download>
            <Download className="size-4" aria-hidden="true" /> Modèle XLSX (avec feuille « Aide »)
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/v1/imports/templates/${model.kind}?format=csv`} download>
            <Download className="size-4" aria-hidden="true" /> Modèle CSV (UTF-8)
          </a>
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <caption className="sr-only">Colonnes du modèle {model.label}</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Colonne</TableHead>
              <TableHead>Obligatoire</TableHead>
              <TableHead>Description et format</TableHead>
              <TableHead>Exemple</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.columns.map((c) => (
              <TableRow key={c.name}>
                <TableCell className="font-mono text-xs">{c.name}</TableCell>
                <TableCell>{c.required ? <StatusBadge label="Obligatoire" tone="warning" /> : <StatusBadge label="Facultative" tone="neutral" />}</TableCell>
                <TableCell className="whitespace-normal">{c.description}</TableCell>
                <TableCell className="font-mono text-xs">{c.example || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function UploadStep({ model }: { model: ImportModel | null }) {
  const queryClient = useQueryClient();
  const { set } = useListParams();
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    mutationFn: ({ kind, file: chosen }: { kind: ImportKind; file: File }) => {
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', chosen);
      return api<ImportBatchView>('/imports', { method: 'POST', formData: form });
    },
    onSuccess: (batch) => {
      queryClient.setQueryData(['import', batch.id], batch);
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
      toast.success('Fichier reçu : associez les colonnes puis lancez le contrôle.');
      set({ lot: batch.id, modele: '' });
    },
  });
  const fieldErrors = isApiError(upload.error) ? upload.error.fieldErrors : {};

  return (
    <section aria-labelledby="import-step-file" className="space-y-4 rounded-lg border p-4">
      <div>
        <h2 id="import-step-file" className="text-lg font-semibold">
          2. Envoyer le fichier
        </h2>
        <p className="text-sm text-muted-foreground">
          {model ? `Modèle choisi : ${model.label}.` : 'Choisissez d’abord un modèle.'} Le fichier est seulement lu et conservé en privé : aucune donnée n’est écrite à cette étape.
        </p>
      </div>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (model && file) upload.mutate({ kind: model.kind, file });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="import-file">Fichier CSV ou XLSX</Label>
          <Input
            id="import-file"
            type="file"
            accept={ACCEPT}
            className="max-w-md"
            disabled={upload.isPending}
            aria-invalid={fieldErrors.file ? true : undefined}
            aria-describedby={fieldErrors.file ? 'file-error' : undefined}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              upload.reset();
            }}
          />
          <FieldError errors={fieldErrors} name="file" />
          <FieldError errors={fieldErrors} name="kind" />
        </div>
        {upload.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {isApiError(upload.error) ? upload.error.message : 'Téléversement impossible : le fichier n’a pas été reçu.'}
          </p>
        ) : null}
        <Button type="submit" disabled={!model || !file || upload.isPending}>
          <Upload className="size-4" aria-hidden="true" /> {upload.isPending ? 'Envoi et lecture du fichier…' : 'Envoyer le fichier'}
        </Button>
      </form>
    </section>
  );
}
