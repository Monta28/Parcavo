// Liens vers la page d'un objet audité ou d'un événement de chronologie. Seules les pages qui existent dans
// apps/web/app/(app) sont ciblées ; un type sans page (segment de compteur, affectation, relevé isolé…)
// n'a pas de lien. La page ouverte revérifie les droits côté serveur (404 hors périmètre) : le lien n'ouvre
// aucun accès.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ObjectLinkOptions {
  /** Véhicule de contexte : pré-filtre les listes ouvertes (documents, réservations) sur ce véhicule. */
  vehicleId?: string;
  /** Les fiches utilisateur ne sont ouvertes qu'à l'administrateur (section Administration). */
  isAdmin?: boolean;
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Chemin de la page de l'objet, ou null si aucune page ne l'affiche (ou identifiant non conforme). */
export function objectHref(objectType: string, objectId: string | null | undefined, options: ObjectLinkOptions = {}): string | null {
  if (!objectId || !UUID.test(objectId)) return null;
  const id = encodeURIComponent(objectId);
  const vehicle = options.vehicleId && UUID.test(options.vehicleId) ? options.vehicleId : undefined;
  switch (objectType) {
    case 'Vehicle':
      return `/vehicules/${id}`;
    case 'Driver':
      return `/conducteurs/${id}`;
    case 'VehicleUsage':
      return `/utilisations/${id}`;
    case 'Intervention':
      return `/interventions/${id}`;
    case 'Incident':
      return `/incidents/${id}`;
    case 'Immobilization':
      return `/immobilisations/${id}`;
    case 'FuelEntry':
      return `/carburant/${id}`;
    case 'DocumentVersion':
      return withQuery('/documents', { onglet: 'versions', vehicule: vehicle, version: objectId });
    case 'Reservation':
      return withQuery('/planning/reservations', { vehicule: vehicle, reservation: objectId });
    case 'VehicleMaintenancePlan':
      return withQuery('/entretiens', { plan: objectId });
    case 'ImportBatch':
      return withQuery('/imports', { lot: objectId });
    case 'User':
      return options.isAdmin ? `/administration/utilisateurs/${id}` : null;
    default:
      return null;
  }
}
