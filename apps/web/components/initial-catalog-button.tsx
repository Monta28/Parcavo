'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PackagePlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/app/(app)/administration/confirm-dialog';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';

interface InstallResult {
  created: Array<{ code: string; label: string }>;
  skipped: Array<{ code: string; label: string; reason: string }>;
}

/** Message de résultat : décomptes renvoyés par l'API (éléments ajoutés, éléments déjà présents non modifiés). */
export function installSummary(result: InstallResult, noun: { singular: string; plural: string; feminine: boolean }): string {
  const e = noun.feminine ? 'e' : '';
  const created = result.created.length;
  const skipped = result.skipped.length;
  const added = created === 0 ? `Aucun${e} ${noun.singular} ajouté${e}` : `${created} ${created > 1 ? noun.plural : noun.singular} ajouté${e}${created > 1 ? 's' : ''}`;
  if (skipped === 0) return `${added}.`;
  return `${added} ; ${skipped} déjà présent${e}${skipped > 1 ? 's' : ''}, non modifié${e}${skipped > 1 ? 's' : ''}.`;
}

/**
 * Installation du catalogue initial (administrateur) : l'API n'ajoute que les éléments absents et ne modifie
 * aucun élément existant ; l'action est rejouable sans effet et auditée côté serveur.
 */
export function InitialCatalogButton({
  endpoint,
  title,
  description,
  noun,
  invalidate,
  size = 'default',
}: {
  endpoint: '/maintenance-types/initial-catalog' | '/document-types/initial-catalog';
  title: string;
  description: React.ReactNode;
  noun: { singular: string; plural: string; feminine: boolean };
  invalidate: string[];
  size?: 'default' | 'sm';
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const install = useMutation({
    mutationFn: () => api<InstallResult>(endpoint, { method: 'POST', idempotencyKey: newIdempotencyKey() }),
    onSuccess: (result) => {
      setOpen(false);
      toast.success(installSummary(result, noun));
      for (const key of invalidate) void queryClient.invalidateQueries({ queryKey: [key] });
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Installation impossible.'),
  });
  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)}>
        <PackagePlus className="size-4" aria-hidden="true" /> Installer le catalogue initial
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !install.isPending) setOpen(false);
        }}
        title={title}
        description={description}
        confirmLabel="Installer"
        pending={install.isPending}
        onConfirm={() => install.mutate()}
      />
    </>
  );
}
