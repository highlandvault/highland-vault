/**
 * Operator CLI: grant a role to an existing account, audited as a system action.
 * This is how the first staff accounts (including the first super_admin) are
 * created; there is no role-management API yet.
 *
 *   pnpm --filter @hv/api build
 *   pnpm --filter @hv/api cli:grant-role -- --email ops@example.com --role super_admin \
 *     --reason "Initial platform administrator (ticket HV-123)" [--market uk]
 *
 * Connects with DATABASE_URL (the runtime role), like the API itself.
 */
import { createDb } from '@hv/db';
import { parseArgs } from 'node:util';
import { AuditService } from '../audit/audit.service';
import { RoleGrantError, grantRole } from '../rbac/role-grants';

async function main(): Promise<number> {
  // `pnpm run <script> -- --flag` passes the "--" separator through; drop it.
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      email: { type: 'string' },
      role: { type: 'string' },
      market: { type: 'string' },
      reason: { type: 'string' },
    },
    strict: true,
  });
  if (!values.email || !values.role || !values.reason) {
    process.stderr.write(
      'usage: grant-role --email <email> --role <role> --reason <text> [--market <code>]\n',
    );
    return 2;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write('DATABASE_URL is not set\n');
    return 2;
  }

  const db = createDb({ connectionString, applicationName: 'hv-cli-grant-role', max: 1 });
  try {
    const result = await grantRole(db, new AuditService(), {
      email: values.email,
      role: values.role,
      market: values.market ?? null,
      reason: values.reason,
      actor: { type: 'system' },
    });
    process.stdout.write(
      result === 'granted'
        ? `granted ${values.role}${values.market ? ` (${values.market})` : ''} to ${values.email}\n`
        : `${values.email} already has ${values.role}; nothing changed\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof RoleGrantError) {
      process.stderr.write(`grant-role: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await db.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `grant-role failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
