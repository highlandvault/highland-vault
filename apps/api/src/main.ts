import { Logger } from 'nestjs-pino';
import { createApp } from './app';
import { parseApiEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = parseApiEnv(process.env);
  const app = await createApp(env);
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.get(Logger).log(`API listening on http://${env.API_HOST}:${env.API_PORT}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid environment), so write directly.
  process.stderr.write(
    `API failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
