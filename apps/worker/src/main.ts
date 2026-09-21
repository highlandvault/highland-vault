import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { parseWorkerEnv } from './config/env';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const env = parseWorkerEnv(process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule.register(env), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // SIGINT/SIGTERM close the worker gracefully (active jobs finish, connections close).
  app.enableShutdownHooks();
  await app.init();
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `Worker failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
