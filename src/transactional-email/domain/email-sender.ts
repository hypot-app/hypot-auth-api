export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
}

/** Port: delivers one message. Throws when the provider rejects or is unreachable. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EmailSender');
