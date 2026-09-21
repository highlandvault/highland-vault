import { type DynamicModule, Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { API_ENV, type ApiEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { RedisModule } from './redis/redis.module';

@Global()
@Module({})
class EnvModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: API_ENV, useValue: env }],
      exports: [API_ENV],
    };
  }
}

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.register(env),
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            // Structured JSON logs. The request id (reqId) is assigned by Fastify, see app.ts.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
          },
        }),
        DatabaseModule,
        RedisModule,
      ],
      controllers: [HealthController],
    };
  }
}
