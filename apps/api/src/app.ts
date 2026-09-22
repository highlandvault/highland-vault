import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import type { ErrorResponse } from '@hv/contracts';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { ApiEnv } from './config/env';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Propagates a caller-supplied request id (bounded length) or generates a UUID. */
export function requestId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const header = req.headers[REQUEST_ID_HEADER];
  return typeof header === 'string' && header.length > 0 && header.length <= 128
    ? header
    : randomUUID();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    if (!SAFE_METHODS.has(request.method)) {
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
