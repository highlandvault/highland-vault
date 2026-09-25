import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { ApiExceptionFilter } from './common/exception.filter';
import { API_ENV, type ApiEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { DrawsModule } from './draws/draws.module';
import { GuestsModule } from './guests/guests.module';
import { HealthController } from './health/health.controller';
import { MarketsModule } from './markets/markets.module';
import { AccessGuard } from './rbac/access.guard';
import { RbacModule } from './rbac/rbac.module';
import { RedisModule } from './redis/redis.module';
import { OrdersModule } from './orders/orders.module';
import { TermsModule } from './terms/terms.module';
import { TicketsModule } from './tickets/tickets.module';

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
        AuditModule,
        RbacModule,
        MarketsModule,
        AuthModule,
        GuestsModule,
        DrawsModule,
        TicketsModule,
        TermsModule,
        CartModule,
        OrdersModule,
      ],
      controllers: [HealthController],
      providers: [
        // Deny-by-default access control for every route (ADR-0010).
        { provide: APP_GUARD, useClass: AccessGuard },
        // Uniform error bodies for every failure.
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    };
  }
}
