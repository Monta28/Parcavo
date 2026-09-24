import { Logger } from '@nestjs/common';

/**
 * File d'actions à exécuter après validation d'une transaction (recalculs dépendants, alertes,
 * notifications). Les actions échouées sont journalisées et rattrapées par la tâche périodique :
 * elles ne remettent jamais en cause l'opération validée.
 */
export class AfterCommit {
  private readonly actions: Array<{ label: string; run: () => Promise<void> }> = [];
  private static readonly logger = new Logger('AfterCommit');

  add(label: string, run: () => Promise<void>): void {
    this.actions.push({ label, run });
  }

  async run(): Promise<void> {
    for (const action of this.actions.splice(0)) {
      try {
        await action.run();
      } catch (error) {
        AfterCommit.logger.error(`Action post-validation « ${action.label} » en échec : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
