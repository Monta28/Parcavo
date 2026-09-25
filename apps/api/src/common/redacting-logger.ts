import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { redactDeep, redactSensitiveText } from './secret-redaction.js';

interface JsonLogObject {
  [key: string]: unknown;
  level: LogLevel;
  pid: number;
  timestamp: number;
  message: unknown;
  context?: string;
  stack?: unknown;
  params?: Record<string, unknown>;
}

/**
 * Journal applicatif avec masquage (D-304, T44) : chaque ligne écrite passe par redactSensitiveText
 * (motifs sensibles et secrets fournisseur en cours d'utilisation), y compris les piles d'erreur et le
 * format JSON. Utilisé par l'API (bootstrap) et réutilisable par le worker.
 */
export class RedactingConsoleLogger extends ConsoleLogger {
  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    params?: Record<string, unknown>,
  ): string {
    return redactSensitiveText(super.formatMessage(logLevel, message, pidMessage, formattedLogLevel, contextMessage, timestampDiff, params));
  }

  protected override printStackTrace(stack: string): void {
    super.printStackTrace(stack ? redactSensitiveText(stack) : stack);
  }

  protected override getJsonLogObject(
    message: unknown,
    options: { context: string; logLevel: LogLevel; writeStreamType?: 'stdout' | 'stderr'; errorStack?: unknown; params?: Record<string, unknown> },
  ): JsonLogObject {
    const logObject = super.getJsonLogObject(message, options);
    return redactDeep(logObject) as typeof logObject;
  }
}
