import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '@hv/db';

export interface UserRecord {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  passwordHash: string;
  status: string;
}

/** Data access for `users`. Callers pass the executor: the pool, or an open transaction. */
@Injectable()
export class UsersRepository {
  async findByEmail(db: DbExecutor, normalizedEmail: string): Promise<UserRecord | null> {
    const row = await db
      .selectFrom('users')
      .select(['id', 'email', 'email_verified_at', 'password_hash', 'status'])
      .where('email', '=', normalizedEmail)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async findById(db: DbExecutor, id: string): Promise<UserRecord | null> {
    const row = await db
      .selectFrom('users')
      .select(['id', 'email', 'email_verified_at', 'password_hash', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  /** Throws a unique violation on users_email_key if the email is already registered. */
  async insert(db: DbExecutor, email: string, passwordHash: string): Promise<{ id: string }> {
    return db
      .insertInto('users')
      .values({ email, password_hash: passwordHash })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  async updatePasswordHash(db: DbExecutor, id: string, passwordHash: string): Promise<void> {
    await db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', id)
      .execute();
  }
}

function toRecord(row: {
  id: string;
  email: string;
  email_verified_at: Date | null;
  password_hash: string;
  status: string;
}): UserRecord {
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: row.password_hash,
    status: row.status,
  };
}
