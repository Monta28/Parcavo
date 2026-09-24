import type { ArchivableStatus, UserStatus } from '@/lib/admin-types';

/** Libellés d'affichage des statuts renvoyés par l'API (toujours accompagnés d'un texte, CDC 10.1). */
export const ARCHIVABLE_STATUS_LABELS: Record<ArchivableStatus, string> = { ACTIF: 'Actif', ARCHIVE: 'Archivé' };
export const COMPANY_STATUS_LABELS: Record<ArchivableStatus, string> = { ACTIF: 'Active', ARCHIVE: 'Archivée' };
export const USER_STATUS_LABELS: Record<UserStatus, string> = { ACTIF: 'Actif', DESACTIVE: 'Désactivé' };

export const ALL = '__all__';
