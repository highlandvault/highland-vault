/**
 * The SMTP adapter against real SMTP (Mailpit). Everything else in the mail
 * path is exercised with a recording mailer; this file is the one place that
 * proves a message actually leaves the process and arrives somewhere.
 */
import { randomUUID } from 'node:crypto';
import { SecretBox, sealPayload } from '@hv/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnconfiguredMailer } from '../src/mail/mail.port';
import { SMTP_TIMEOUT_MS, SmtpMailer } from '../src/mail/smtp-mailer';
import {
  VERIFICATION_EMAIL_TOPIC,
  createVerificationEmailOpener,
  renderVerificationEmail,
} from '../src/mail/verification-email';
import { CLAIM_LEASE_SECONDS } from '../src/outbox/outbox';

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set. Copy .env.example to .env and run pnpm infra:up.`);
  return value;
}

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

const mailpitApi = () => required('TEST_MAILPIT_API_URL').replace(/\/$/, '');

/** Mailpit keeps every message; find ours by its unique recipient. */
async function findMessage(recipient: string): Promise<MailpitMessage | undefined> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(
      `${mailpitApi()}/api/v1/search?query=${encodeURIComponent(recipient)}`,
    );
    if (response.ok) {
      const body = (await response.json()) as { messages?: MailpitMessage[] };
      const found = body.messages?.find((m) => m.To.some((t) => t.Address === recipient));
      if (found) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function bodyOf(id: string): Promise<string> {
  const response = await fetch(`${mailpitApi()}/api/v1/message/${id}`);
  const body = (await response.json()) as { Text?: string };
  return body.Text ?? '';
}

describe('SMTP adapter (Mailpit)', () => {
  let mailer: SmtpMailer;

  beforeAll(() => {
    mailer = new SmtpMailer({ url: required('SMTP_URL'), from: required('MAIL_FROM') });
  });

  afterAll(() => {
    mailer.close();
  });

  it('delivers a verification email that a real SMTP server accepts', async () => {
    const recipient = `guest-${randomUUID()}@example.com`;
    const code = '481592';
    const box = new SecretBox('a1'.repeat(16) + 'b2'.repeat(16), 'k1');
    const open = createVerificationEmailOpener(box);

    // Sealed by the producer, opened only here, exactly as the worker does it.
    const sealed = sealPayload(box, VERIFICATION_EMAIL_TOPIC, {
      to: recipient,
      code,
      expiresInMinutes: 10,
    });
    await mailer.send(renderVerificationEmail(open(VERIFICATION_EMAIL_TOPIC, sealed)));

    const message = await findMessage(recipient);
    expect(message, 'message did not arrive in Mailpit').toBeDefined();
    expect(message!.Subject).toContain('verification code');
    expect(await bodyOf(message!.ID)).toContain(code);
  });

  it('throws when the SMTP server cannot be reached, so the event is not published', async () => {
    // Port 1 on loopback: refused immediately, the same trick the health tests use.
    const unreachable = new SmtpMailer({ url: 'smtp://127.0.0.1:1', from: 'x@example.com' });
    try {
      await expect(
        unreachable.send({ to: 'nobody@example.com', subject: 's', text: 't' }),
      ).rejects.toThrow();
    } finally {
      unreachable.close();
    }
  });

  it('refuses to send at all when mail is unconfigured', async () => {
    await expect(
      new UnconfiguredMailer('SMTP_URL is unset').send({
        to: 'nobody@example.com',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow('mail is not configured');
  });

  it('times out well inside the outbox claim lease', () => {
    // ADR-0028: a send must resolve within its own lease, or the event can be
    // relayed a second time while the first is still in flight.
    expect(SMTP_TIMEOUT_MS).toBeLessThan(CLAIM_LEASE_SECONDS * 1000);
  });
});
