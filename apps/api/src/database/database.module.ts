import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Database } from '@hv/db';
import { API_ENV, type ApiEnv } from '../config/env';

export const DATABASE = Symbol('DATABASE');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Database =>
        createDb({ connectionString: env.DATABASE_URL, applicationName: 'hv-api' }),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
