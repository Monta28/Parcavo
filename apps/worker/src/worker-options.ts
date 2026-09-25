/** Options du module worker (jeton d'injection). */
export const WORKER_OPTIONS = Symbol('WORKER_OPTIONS');

export interface WorkerOptions {
  /**
   * Armement des minuteurs de planification au démarrage (vrai en exploitation). Les tests le désactivent
   * et déclenchent les tâches explicitement, avec une horloge contrôlable.
   */
  schedule: boolean;
}
