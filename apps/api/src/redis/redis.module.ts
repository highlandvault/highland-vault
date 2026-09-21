import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { API_ENV, type ApiEnv } from '../config/env';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Redis => {
        const logger = new Logger('Redis');
        const redis = new Redis(env.REDIS_URL, {
          // Fail individual commands quickly instead of queueing them forever while Redis is down.
          maxRetriesPerRequest: 1,
          connectTimeout: 5_000,
        });
        // Without an 'error' listener ioredis would crash the process on connection errors;
        // reconnection is automatic and readiness reports the outage.
        redis.on('error', (error: Error) =>
          logger.warn(`redis connection error: ${error.message}`),
        );
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
