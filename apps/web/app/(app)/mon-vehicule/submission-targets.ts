'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { SubmissionTargetView } from '@/lib/fuel-types';

/** Libellé d'un véhicule proposé au titre de la responsabilité habituelle (D-268), commun aux trois actions. */
export const HABITUAL_VEHICLE_LABEL = 'Véhicule dont vous êtes responsable habituel';

/**
 * Véhicules sur lesquels le conducteur connecté peut soumettre maintenant (GET /driver-submissions/vehicles ;
 * D-116, D-268) : celui de son utilisation EN_COURS ou, si l'organisation active
 * drivers.allowHabitualVehicleSubmissions, celui dont il est responsable habituel. Source unique de l'activation
 * des actions de « Mon véhicule » : l'écran ne recalcule pas la règle, le serveur la revérifie à chaque envoi.
 * Même clé de requête que le ticket carburant : une seule requête pour tout l'écran.
 */
export function useSubmissionTargets() {
  return useQuery({ queryKey: ['driver-submissions', 'vehicles'], queryFn: () => api<SubmissionTargetView[]>('/driver-submissions/vehicles') });
}
