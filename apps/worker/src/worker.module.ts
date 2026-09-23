import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createDb, type Database } from '@hv/db';
import { Redis } from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import { WORKER_ENV, type WorkerEnv } from './config/env';
import { DrawLifecycleService } from './draws/draw-lifecycle.service';
import { ReservationExpiryService } from './tickets/reservation-expiry.service';
import { SystemService } from './system/system.service';
import { DATABASE, REDIS } from './tokens';

@Module({})
export class WorkerModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  static register(env: WorkerEnv): DynamicModule {
    return {
      module: WorkerModule,
      imports: [LoggerModule.forRoot({ pinoHttp: { level: env.LOG_LEVEL } })],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        {
          provide: DATABASE,
          useFactory: (): Database =>
            createDb({ connectionString: env.DATABASE_URL, applicationName: 'hv-worker', max: 5 }),
        },
        {
          provide: REDIS,
          useFactory: (): Redis => {
            const logger = new Logger('Redis');
            // BullMQ requires maxRetriesPerRequest: null for its blocking connections.
            const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
            redis.on('error', (error: Error) =>
              logger.warn(`redis connection error: ${error.message}`),
            );
            return redis;
          },
        },
        SystemService,
        DrawLifecycleService,
        ReservationExpiryService,
      ],
    };
  }

  /** Runs after the services' onModuleDestroy hooks have closed their queues and workers. */
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
    if (this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
  }
}
