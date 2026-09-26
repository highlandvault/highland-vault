import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ErrorResponse } from '@hv/contracts';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { ApiEnv } from './config/env';
import {
  WEBHOOK_MAX_BODY_BYTES,
  isProviderWebhookRoute,
  type WithRawBody,
} from './webhooks/webhook-request';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Propagates a caller-supplied request id (bounded length) or generates a UUID. */
export function requestId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const header = req.headers[REQUEST_ID_HEADER];
  return typeof header === 'string' && header.length > 0 && header.length <= 128
    ? header
    : randomUUID();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A provider sent more than a payment event could reasonably be.
 *
 * `statusCode` is what the exception filter reads to answer 4xx, which is the
 * right class: a body this large will be just as large next time, so there is
 * nothing for the provider to gain by retrying.
 */
class WebhookBodyTooLarge extends Error {
  readonly statusCode = 413;
  constructor() {
    super('webhook body is too large');
  }
}

/** What Fastify parses for a webhook, so the real bytes reach verification untouched. */
const EMPTY_JSON_BODY = Buffer.from('{}', 'utf8');

/** Builds the (not yet listening) API application. Shared by main.ts and tests. */
export async function createApp(env: ApiEnv): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(env),
    // Fastify owns request ids; pino-http logs them as reqId on every request log line.
    new FastifyAdapter({
      requestIdHeader: false,
      genReqId: requestId,
      // request.ip honours X-Forwarded-For only from these proxies (default: none).
      trustProxy: env.TRUST_PROXY.length > 0 ? env.TRUST_PROXY : false,
      bodyLimit: 64 * 1024,
    }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));

  const allowedOrigins = new Set(env.WEB_ORIGINS);
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', (request, reply, done) => {
    // Echo the id so clients and support can correlate a response with its log lines.
    void reply.header(REQUEST_ID_HEADER, request.id);

    // CSRF protection (Revision 2 B19): state-changing requests must come from an
    // allowed browser origin. Together with SameSite=Lax session cookies this
    // blocks cross-site form posts and scripted requests from other sites.
    //
    // Provider webhooks are exempt (D5 = B). They carry no cookie and no
    // session, so there is no ambient credential for an origin to protect, and
    // a server-to-server caller cannot report one honestly. Their signature is
    // their authentication; see webhooks/webhook-request.ts for why the two
    // defences are not interchangeable.
    if (!SAFE_METHODS.has(request.method) && !isProviderWebhookRoute(request)) {
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !allowedOrigins.has(origin)) {
        const body: ErrorResponse = {
          error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed.' },
          requestId: String(request.id),
        };
        void reply.status(403).send(body);
        return;
      }
    }
    done();
  });

  // Raw bytes for provider webhooks, and nothing else (D6 = C).
  //
  // A signature covers the bytes the provider sent. Parsing JSON and
  // re-serialising it reorders keys and rewrites numbers, so verifying against
  // the round trip fails for every honest request — and could be made to pass
  // for a crafted one. The bytes therefore have to be kept before anything
  // touches them.
  //
  // This is a `preParsing` hook rather than a replacement JSON parser on
  // purpose: every other route in the API parses exactly as it did before, and
  // no other request pays for a second copy of its body in memory.
  fastify.addHook('preParsing', (request, _reply, payload, done) => {
    if (!isProviderWebhookRoute(request)) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    payload.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Refused by us, with our own answer, rather than by the framework with
      // one that reads like a signature failure.
      if (size > WEBHOOK_MAX_BODY_BYTES) {
        payload.destroy(new WebhookBodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    payload.on('end', () => {
      (request as FastifyRequest & WithRawBody).rawBody = Buffer.concat(chunks);
      // Fastify is handed an empty object instead of the real bytes, and the
      // controller reads `rawBody` rather than the parsed body.
      //
      // This is not a trick to avoid parsing — it is the order the signature
      // requires. Letting the JSON parser see an unauthenticated body means an
      // unreadable one is refused before it has been verified at all, with a
      // parser's message that says which failure it was. A caller could then
      // tell a bad signature from a bad body and work towards a valid one, and
      // the bytes would have decided something before anything proved they
      // came from the provider. Verification comes first; the port parses what
      // it has verified.
      const raw = (request as FastifyRequest & WithRawBody).rawBody;
      const replacement = Readable.from([EMPTY_JSON_BODY]) as Readable & {
        receivedEncodedLength?: number;
      };
      // Fastify checks what it read against Content-Length. It is reading a
      // stand-in now, so it is told how many bytes actually arrived — otherwise
      // every webhook is refused for a length mismatch that is our own doing.
      replacement.receivedEncodedLength = raw?.length ?? 0;
      done(null, replacement);
    });
    payload.on('error', (error: Error) => done(error));
  });

  fastify.addHook('onSend', (_request, reply, payload, done) => {
    // API responses are never framed, sniffed or cached by intermediaries.
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  app.enableShutdownHooks();
  return app;
}
