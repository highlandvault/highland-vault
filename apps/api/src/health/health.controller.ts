import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { DependencyCheck, LivenessResponse, ReadinessResponse } from '@hv/contracts';
import { sql, type Database } from '@hv/db';
import type { Redis } from 'ioredis';
import { DATABASE } from '../database/database.module';
import { REDIS } from '../redis/redis.module';

const CHECK_TIMEOUT_MS = 2_000;

async function timed(check: () => Promise<unknown>): Promise<DependencyCheck> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : 'unknown error',
    };
  } finally {
    clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The process is up and serving HTTP. Never touches dependencies. */
  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  /** 200 only when PostgreSQL and Redis both respond; otherwise 503 with per-dependency detail. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessResponse> {
    const [database, redis] = await Promise.all([
      timed(() => sql`SELECT 1`.execute(this.db)),
      timed(() => this.redis.ping()),
    ]);
    const ok = database.status === 'up' && redis.status === 'up';
    void reply.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'unavailable', checks: { database, redis } };
  }
}
