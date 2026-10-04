import { createTransport, type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from '../domain/email-sender';

export interface SmtpSettings {
  host: string;
  port: number;
  /** True means implicit TLS (usually port 465). False still upgrades through STARTTLS when offered. */
  secure: boolean;
  auth: { user: string; pass: string } | undefined;
}

/** One plain mailbox: no display name, no list, no whitespace or control characters. */
const SINGLE_ADDRESS = /^[^\s@,;<>"()[\]\\]+@[^\s@,;<>"()[\]\\]+$/;

/** Bounds on a provider that accepts the connection and then goes quiet; the worker holds a transaction meanwhile. */
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * Generic SMTP delivery through Nodemailer (ADR 17). Any relay works by changing the
 * SMTP_* settings. Nothing is logged here: Nodemailer's logger stays off, so the
 * credentials never reach any log, and errors propagate to the caller untouched.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(settings: SmtpSettings) {
    this.transport = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      ...(settings.auth ? { auth: settings.auth } : {}),
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    // Nodemailer would deliver to every address in a list; the recipient is data a user typed.
    if (!SINGLE_ADDRESS.test(message.to)) throw new Error('invalid recipient');
    await this.transport.sendMail({
      to: message.to,
      from: message.from,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    });
  }
}
