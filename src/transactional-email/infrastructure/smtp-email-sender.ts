import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { isPlainMailbox } from '../../shared-kernel/mailbox';
import type { EmailMessage, EmailSender } from '../domain/email-sender';

export interface SmtpSettings {
  host: string;
  port: number;
  /** True means implicit TLS (usually port 465). False still upgrades through STARTTLS when offered. */
  secure: boolean;
  auth: { user: string; pass: string } | undefined;
}

/** Bounds on a provider that accepts the connection and then goes quiet. The worker's send deadline is the overall cap. */
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * Transport options for a configuration. With credentials and no implicit TLS, STARTTLS
 * is required: Nodemailer would otherwise fall back to plaintext AUTH when a network
 * attacker strips the STARTTLS offer, leaking the SMTP password.
 */
export function buildTransportOptions(settings: SmtpSettings): SMTPTransport.Options {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.auth ? { auth: settings.auth } : {}),
    ...(settings.auth && !settings.secure ? { requireTLS: true } : {}),
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };
}

/**
 * Generic SMTP delivery through Nodemailer (ADR 17). Any relay works by changing the
 * SMTP_* settings. Nothing is logged here: Nodemailer's logger stays off, so the
 * credentials never reach any log, and errors propagate to the caller untouched.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(settings: SmtpSettings) {
    this.transport = createTransport(buildTransportOptions(settings));
  }

  async send(message: EmailMessage): Promise<void> {
    // Nodemailer would deliver to every address in a list; the recipient is data a user typed.
    if (!isPlainMailbox(message.to)) throw new Error('invalid recipient');
    await this.transport.sendMail({
      to: message.to,
      from: message.from,
      subject: message.subject,
      text: message.text,
    });
  }
}
