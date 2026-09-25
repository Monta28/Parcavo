import { createTransport } from 'nodemailer';
import type { AppEnv } from '@parc-auto/api';

export type SmtpConfig = NonNullable<AppEnv['smtp']>;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Identifiant de la ligne d'outbox, porté en en-tête technique (traçabilité, aucune donnée personnelle). */
  outboxId: string;
}

export interface MailSender {
  send(message: MailMessage): Promise<{ messageId: string | null }>;
  close(): void;
}

/** Délais réseau bornés : une panne SMTP ne bloque jamais la ligne au-delà de son verrou (2 min). */
const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;

/**
 * Envoi SMTP réel (nodemailer) : texte brut, sans pièce jointe ni accès fichier/URL (CDC 9.4, D-261).
 * Les identifiants restent dans la configuration du transport et ne sont jamais journalisés.
 */
export function createSmtpSender(config: SmtpConfig): MailSender {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}),
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(message: MailMessage): Promise<{ messageId: string | null }> {
      const info = await transport.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text, headers: { 'X-Parc-Auto-Outbox': message.outboxId } });
      return { messageId: typeof info.messageId === 'string' ? info.messageId : null };
    },
    close(): void {
      transport.close();
    },
  };
}
