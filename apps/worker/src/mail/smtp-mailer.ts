/**
 * SMTP adapter for MailPort. `nodemailer` is imported here and nowhere else,
 * so swapping providers (O14) means adding a sibling adapter, not touching
 * notification code.
 *
 * In development and tests the target is Mailpit, which accepts everything and
 * delivers nowhere — the safe default while no market can be enabled on a real
 * database.
 */
import { createTransport, type Transporter } from 'nodemailer';
import type { MailMessage, MailPort } from './mail.port';

/**
 * Kept well below the outbox claim lease (ADR-0028): a send must resolve
 * inside its own lease, or the event can be relayed a second time while the
 * first is still in flight.
 */
export const SMTP_TIMEOUT_MS = 20_000;

export interface SmtpMailerOptions {
  /** smtp://host:port — Mailpit locally. */
  readonly url: string;
  readonly from: string;
}

export class SmtpMailer implements MailPort {
  private readonly transport: Transporter;

  constructor(private readonly options: SmtpMailerOptions) {
    this.transport = createTransport({
      url: options.url,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }

  async send(message: MailMessage): Promise<void> {
    // Nothing from the message body is logged or re-thrown by this adapter:
    // a verification mail carries a one-time code (ADR-0028).
    await this.transport.sendMail({
      from: this.options.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    });
  }

  close(): void {
    this.transport.close();
  }
}
