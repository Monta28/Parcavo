'use client';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isApiError } from '@/lib/api-error';
import type { IncidentView } from '@/lib/incidents-types';

/** Mise à jour du cache après une action réussie ; rechargement de la fiche sur conflit (409). */
export function useIncidentCache(incidentId: string) {
  const queryClient = useQueryClient();
  return {
    saved(updated: IncidentView, message: string) {
      toast.success(message);
      queryClient.setQueryData(['incident', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['incident', updated.id, 'comments'] });
      void queryClient.invalidateQueries({ queryKey: ['immobilizations'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', updated.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
    },
    /** Renvoie vrai si la fenêtre doit être fermée (version obsolète : la fiche est rechargée). */
    failed(error: unknown, fallback: string): boolean {
      toast.error(isApiError(error) ? error.message : fallback);
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['incident', incidentId] });
        if (error.code === 'VERSION_OBSOLETE') {
          toast.info('La fiche a été rechargée avec la version courante : vérifiez puis relancez l’action.');
          return true;
        }
      }
      return false;
    },
  };
}
