import type { ImportBatchStatus, ImportRowStatus } from '@/lib/imports-types';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** Couleur d'accompagnement des statuts (le libellé texte reste toujours affiché, CDC 10.1). */
export function toneForBatch(status: ImportBatchStatus): Tone {
  switch (status) {
    case 'CONFIRME':
      return 'success';
    case 'CONTROLE':
      return 'info';
    case 'TELEVERSE':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function toneForRow(status: ImportRowStatus): Tone {
  switch (status) {
    case 'VALIDE':
    case 'IMPORTEE':
      return 'success';
    case 'ERREUR':
      return 'danger';
    default:
      return 'neutral';
  }
}
