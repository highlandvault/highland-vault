import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

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

/** Builds the (not yet listening) API application. Shared by main.ts and tests. */
export async function createApp(env: ApiEnv): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(env),
    // Fastify owns request ids; pino-http logs them as reqId on every request log line.
    new FastifyAdapter({ requestIdHeader: false, genReqId: requestId }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  // Echo the id so clients and support can correlate a response with its log lines.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });
  app.enableShutdownHooks();
  return app;
}
