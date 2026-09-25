/** Résumé d'exécution : comptes et statuts uniquement, jamais d'adresse, de nom ni de secret. */
export type TaskSummary = Record<string, string | number | boolean | null | Array<Record<string, string | number | boolean | null>>>;

/** Traitement planifié exécuté par un seul worker à la fois (bail JobLease du même nom). */
export interface ScheduledTask {
  /** Nom du bail (JobLease.name) et de la tâche dans les journaux. */
  readonly name: string;
  /** Période de réveil du planificateur pour cette tâche. */
  readonly periodMs: number;
  /** Durée du bail, renouvelé pendant l'exécution. */
  readonly leaseMs: number;
  run(now: Date): Promise<TaskSummary>;
}
