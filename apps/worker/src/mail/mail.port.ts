/**
 * Provider-independent mail (ADR-0028, following ADR-0006's shape for
 * payments): commerce and notification code depends on this interface, never
 * on a provider SDK.
 *
 * Phase 5 ships one implementation, an SMTP adapter aimed at Mailpit for
 * development and tests. The production provider is OPEN O14 and is not chosen
 * here; a production configuration without explicit mail settings fails closed
 * at startup rather than silently dropping mail.
 */

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text body. Every message has one; HTML is optional. */
  readonly text: string;
  readonly html?: string;
}

export interface MailPort {
  /**
   * Hands the message to the provider. Resolves only once the provider has
   * accepted it, because that acceptance is what marks an outbox event
   * published (ADR-0028). Throws on refusal or timeout, and the caller then
   * leaves the event unpublished for a later attempt.
   */
  send(message: MailMessage): Promise<void>;
}

/**
 * Refuses to send. Used when no mail configuration is present, so a
 * misconfigured deployment fails loudly on the first message instead of
 * appearing to work while nothing is delivered.
 */
export class UnconfiguredMailer implements MailPort {
  constructor(private readonly reason: string) {}

  /** The message is ignored on purpose: it carries a one-time code. */
  send(_message: MailMessage): Promise<void> {
    return Promise.reject(new Error(`mail is not configured: ${this.reason}`));
  }
}
