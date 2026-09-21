/**
 * Usage (from the repo root):
 *   pnpm db:migrate up       apply pending migrations
 *   pnpm db:migrate status   list applied / pending / drifted migrations
 *   pnpm db:migrate verify   exit 1 unless the database matches the files exactly
 *
 * Connects with MIGRATION_DATABASE_URL (owner role). `--dir <path>` overrides the
 * migrations directory (default: packages/db/migrations).
 */
import path from 'node:path';
import { MigrationStateError } from './files';
import { migrateUp, migrationStatus, migrationVerify } from './runner';

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function write(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function redact(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const dirFlag = rest.indexOf('--dir');
  const migrationsDir =
    dirFlag >= 0 && rest[dirFlag + 1] ? path.resolve(rest[dirFlag + 1]!) : DEFAULT_MIGRATIONS_DIR;

  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    write('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
    return 2;
  }
  const options = { connectionString, migrationsDir };
  write(`database:   ${redact(connectionString)}`);
  write(`migrations: ${migrationsDir}`);

  switch (command) {
    case 'up': {
      const applied = await migrateUp(options);
      if (applied.length === 0) {
        write('up: nothing to apply, database is up to date.');
      } else {
        for (const file of applied) write(`up: applied ${file.filename}`);
        write(`up: ${applied.length} migration(s) applied.`);
      }
      return 0;
    }
    case 'status': {
      const report = await migrationStatus(options);
      write();
      write('VERSION  STATE         APPLIED AT                NAME');
      for (const entry of report.entries) {
        write(
          `${entry.version.padEnd(8)} ${entry.state.padEnd(13)} ${(entry.appliedAt?.toISOString() ?? '-').padEnd(25)} ${entry.name}`,
        );
      }
      write();
      for (const problem of report.problems) write(`PROBLEM: ${problem}`);
      write(
        `status: ${report.entries.filter((e) => e.state === 'applied').length} applied, ${report.pending.length} pending, ${report.problems.length} problem(s).`,
      );
      return report.problems.length > 0 ? 1 : 0;
    }
    case 'verify': {
      const result = await migrationVerify(options);
      if (result.ok) {
        write(
          `verify: OK — ${result.appliedCount} migration(s) applied, all checksums match, none pending.`,
        );
        return 0;
      }
      for (const problem of result.problems) write(`verify: FAIL — ${problem}`);
      return 1;
    }
    default:
      write('Usage: migrate <up|status|verify> [--dir <path>]');
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof MigrationStateError) {
      write(error.message);
      write(
        'Refusing to continue. Fix the migration files or history; never edit applied migrations.',
      );
    } else {
      write(`migrate: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  },
);
