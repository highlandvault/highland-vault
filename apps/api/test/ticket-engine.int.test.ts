/**
 * Ticket engine under real concurrency (Revision 2 B21 Gates 1 and 2, expiry
 * races), against real PostgreSQL with many simultaneous transactions. The
 * allocation under test is exactly the API's: TicketAllocator (transaction +
 * contention retry) around TicketsRepository.allocate.
 */
import { createDb, type Database } from '@hv/db';
import {
  createTestDatabase,
  enableMarketsForTesting,
  insertFixtureDraw,
  type TestDatabase,
} from '@hv/db/testing';
import { ReservationRefused } from '@hv/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TicketAllocator } from '../src/tickets/ticket-allocator';
import {
  type AllocatableDraw,
  type EntrantRef,
  TicketsRepository,
} from '../src/tickets/tickets.repository';

const repo = new TicketsRepository();
const ROUNDS = 3;

// Hundreds of real transactions per scenario, repeated ROUNDS times: slow machines need time.
describe('ticket engine concurrency (real PostgreSQL)', { timeout: 120_000 }, () => {
  let database: TestDatabase;
  let db: Database;
  let sql: pg.Pool;
  let userIds: string[];
  let allocator: TicketAllocator;

  beforeAll(async () => {
    database = await createTestDatabase();
    // Enough connections for dozens of transactions to be in flight at once.
    db = createDb({ connectionString: database.url, applicationName: 'hv-test-gates', max: 60 });
    sql = new pg.Pool({ connectionString: database.url, max: 4 });
    allocator = new TicketAllocator(db, repo);
    await enableMarketsForTesting(sql, ['uk']);
    const users = await sql.query<{ id: string }>(
      `INSERT INTO users (email, password_hash)
       SELECT 'gate-' || g || '@example.com',
              '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
         FROM generate_series(1, 200) g
       RETURNING id`,
    );
    userIds = users.rows.map((r) => r.id);
  });

  afterAll(async () => {
    await db?.destroy();
    await sql?.end();
    await database?.drop();
  });

  async function openDraw(
    slug: string,
    totalTickets: number,
    maxPerPerson: number,
  ): Promise<AllocatableDraw> {
    const id = await insertFixtureDraw(sql, {
      market: 'uk',
      slug,
      state: 'live',
      totalTickets,
      maxPerPerson,
    });
    const { rows } = await sql.query<{ market_id: string }>(
      `SELECT market_id FROM draws WHERE id = $1`,
      [id],
    );
    return {
      id,
      marketId: rows[0]!.market_id,
      currency: 'GBP',
      ticketPriceMinor: 250,
      maxPerPerson,
    };
  }

  const userEntrant = (i: number): EntrantRef => ({
    type: 'user',
    ref: userIds[i]!,
    userId: userIds[i]!,
  });

  /** One reservation attempt in its own transaction: the numbers, or the refusal reason. */
  async function attempt(draw: AllocatableDraw, entrant: EntrantRef, quantity: number, ttl = 600) {
    try {
      const result = await allocator.reserve(draw, entrant, quantity, ttl);
      return {
        ok: true as const,
        numbers: result.ticketNumbers,
        reservationId: result.reservationId,
      };
    } catch (error) {
      if (error instanceof ReservationRefused) return { ok: false as const, reason: error.reason };
      throw error;
    }
  }

  /** Database-side truth for a draw: holders per ticket and counters. */
  async function audit(drawId: string) {
    const tickets = await sql.query<{
      ticket_number: number;
      status: string;
      reservation_id: string | null;
    }>(`SELECT ticket_number, status, reservation_id FROM tickets WHERE draw_id = $1`, [drawId]);
    const reservedByActive = await sql.query<{
      reservation_id: string;
      n: number;
      quantity: number;
    }>(
      `SELECT t.reservation_id, count(*)::int AS n, r.quantity
         FROM tickets t JOIN reservations r ON r.id = t.reservation_id
        WHERE t.draw_id = $1 AND t.status = 'reserved' AND r.status = 'active'
        GROUP BY t.reservation_id, r.quantity`,
      [drawId],
    );
    const counters = await sql.query<{ entrant_ref: string; count: number }>(
      `SELECT entrant_ref, count FROM draw_entrant_counts WHERE draw_id = $1`,
      [drawId],
    );
    const held = await sql.query<{ entrant_ref: string; n: number }>(
      `SELECT r.entrant_ref, count(*)::int AS n
         FROM tickets t JOIN reservations r ON r.id = t.reservation_id
        WHERE t.draw_id = $1 AND t.status IN ('reserved', 'sold')
        GROUP BY r.entrant_ref`,
      [drawId],
    );
    return {
      tickets: tickets.rows,
      reservedByActive: reservedByActive.rows,
      counters: counters.rows,
      held: held.rows,
    };
  }

  /** Invariants that must hold after ANY interleaving. */
  async function expectConsistent(drawId: string) {
    const a = await audit(drawId);
    // Every reserved ticket belongs to an active reservation that holds exactly its quantity.
    const reserved = a.tickets.filter((t) => t.status === 'reserved');
    expect(reserved.every((t) => t.reservation_id !== null)).toBe(true);
    for (const r of a.reservedByActive) expect(r.n).toBe(r.quantity);
    expect(a.reservedByActive.reduce((s, r) => s + r.n, 0)).toBe(reserved.length);
    // Each entrant's counter equals the tickets it really holds.
    const heldBy = new Map(a.held.map((h) => [h.entrant_ref, h.n]));
    for (const c of a.counters) expect(c.count, c.entrant_ref).toBe(heldBy.get(c.entrant_ref) ?? 0);
    return a;
  }

  it('Gate 1: 200 buyers race for 100 tickets — exactly 100 reserved, every number unique', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const draw = await openDraw(`gate1-${round}`, 100, 1);
      const results = await Promise.all(userIds.map((_, i) => attempt(draw, userEntrant(i), 1)));

      const won = results.filter((r) => r.ok);
      const numbers = won.flatMap((r) => r.numbers);
      expect(won).toHaveLength(100);
      expect(new Set(numbers).size).toBe(100);
      expect([...numbers].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
      expect(results.filter((r) => !r.ok).every((r) => r.reason === 'insufficient_tickets')).toBe(
        true,
      );
      const a = await expectConsistent(draw.id);
      expect(a.tickets.filter((t) => t.status === 'available')).toHaveLength(0);
    }
  });

  it('100 concurrent requests for 10 tickets each never share a ticket', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const draw = await openDraw(`bulk-${round}`, 1000, 10);
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => attempt(draw, userEntrant(i), 10)),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      const numbers = results.flatMap((r) => (r.ok ? r.numbers : []));
      expect(numbers).toHaveLength(1000);
      expect(new Set(numbers).size).toBe(1000);
      await expectConsistent(draw.id);
    }
  });

  it('near exhaustion: 5 left, 10 buyers want 5 each — one wins, the rest fail cleanly, nothing partial', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const draw = await openDraw(`scarce-${round}`, 105, 100);
      // Leave exactly 5 available.
      const first = await attempt(draw, userEntrant(150), 100);
      expect(first.ok).toBe(true);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => attempt(draw, userEntrant(i), 5)),
      );
      const won = results.filter((r) => r.ok);
      expect(won).toHaveLength(1);
      expect(won[0]!.numbers).toEqual([101, 102, 103, 104, 105]);
      expect(results.filter((r) => !r.ok).map((r) => r.reason)).toEqual(
        Array(9).fill('insufficient_tickets'),
      );
      // The losers left no reservation behind.
      const { rows } = await sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM reservations WHERE draw_id = $1`,
        [draw.id],
      );
      expect(rows[0]!.n).toBe(2);
      await expectConsistent(draw.id);
    }
  });

  it('Gate 2: 20 concurrent requests from one user with cap 5 get at most 5 tickets', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const draw = await openDraw(`cap-user-${round}`, 1000, 5);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => attempt(draw, userEntrant(0), 1)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(results.filter((r) => !r.ok).every((r) => r.reason === 'cap_exceeded')).toBe(true);
      const a = await expectConsistent(draw.id);
      expect(a.counters).toEqual([{ entrant_ref: userIds[0], count: 5 }]);
    }
  });

  it('Gate 2: the same holds for the verified-email key (guest entrants)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const draw = await openDraw(`cap-email-${round}`, 1000, 5);
      const guest: EntrantRef = { type: 'email', ref: 'guest@example.com', userId: null };
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => attempt(draw, guest, i % 2 === 0 ? 1 : 2)),
      );
      const reserved = results.reduce((sum, r) => sum + (r.ok ? r.numbers.length : 0), 0);
      expect(reserved).toBeLessThanOrEqual(5);
      expect(reserved).toBeGreaterThanOrEqual(4); // 1+2+2 or 1+1+1+2 … the cap is reached or one short
      const a = await expectConsistent(draw.id);
      expect(a.counters).toEqual([{ entrant_ref: 'guest@example.com', count: reserved }]);
    }
  });

  it('expiry racing new reservations never gives one ticket to two active reservations', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const draw = await openDraw(`expiry-race-${round}`, 60, 10);
      // 30 short reservations of 2 tickets fill the pool half-way.
      for (let i = 0; i < 30; i++) {
        const r = await attempt(draw, userEntrant(i), 2, 1);
        expect(r.ok).toBe(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 1100)); // all 30 are now past expiry

      const sweeps = Array.from({ length: 4 }, () => repo.expireDue(db, draw.id, 8));
      const buyers = Array.from({ length: 40 }, (_, i) => attempt(draw, userEntrant(100 + i), 2));
      const [swept, bought] = await Promise.all([Promise.all(sweeps), Promise.all(buyers)]);
      // Whatever interleaving happened, the database stays consistent...
      const a = await expectConsistent(draw.id);
      // ...no ticket has two holders (UNIQUE ticket rows + one reservation_id), and
      // every successful buyer holds exactly what it was given.
      const numbers = bought.flatMap((r) => (r.ok ? r.numbers : []));
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(a.tickets.filter((t) => t.status === 'reserved').length).toBeLessThanOrEqual(60);
      expect(swept.reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(30);
    }
  });

  it('works on a realistically sized pool (50,000 tickets) without scanning it', async () => {
    const started = Date.now();
    const draw = await openDraw('large-pool', 50_000, 50);
    const publishMs = Date.now() - started;
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => attempt(draw, userEntrant(i), 20)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const numbers = results.flatMap((r) => (r.ok ? r.numbers : []));
    expect(new Set(numbers).size).toBe(1000);
    // Sequential numbering: the lowest 1,000 numbers are the ones taken.
    expect(Math.max(...numbers)).toBe(1000);
    await expectConsistent(draw.id);
    // Reported, not asserted: pool generation speed depends on the machine.
    process.stdout.write(`50,000-ticket pool generated and published in ${publishMs} ms\n`);
  });
});
