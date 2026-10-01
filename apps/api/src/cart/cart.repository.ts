import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';

/**
 * Whose basket this is (ADR-0031). Exactly one of the two is set, which the
 * database enforces with a CHECK rather than leaving it to callers.
 */
export type CartOwner =
  { kind: 'user'; userId: string } | { kind: 'guest'; guestSessionId: string };

export interface CartRecord {
  readonly id: string;
  readonly marketId: string;
  readonly owner: CartOwner;
}

export interface CartItemRecord {
  readonly id: string;
  readonly reservationId: string;
  readonly drawId: string;
  readonly createdAt: Date;
}

@Injectable()
export class CartRepository {
  /** The caller's basket in this market, or null when they have never had one. */
  async find(db: DbExecutor, marketId: string, owner: CartOwner): Promise<CartRecord | null> {
    const row = await this.ownerQuery(db, marketId, owner).executeTakeFirst();
    return row ? toCart(row) : null;
  }

  /**
   * The basket, created if it does not exist yet.
   *
   * `ON CONFLICT DO NOTHING` against the owner's partial unique index, then a
   * read: two requests adding their first item at the same moment both end up
   * with the one basket instead of one of them failing. The insert and the
   * read are in the caller's transaction, so the row is theirs by the time
   * anything is added to it.
   */
  async findOrCreate(db: DbExecutor, marketId: string, owner: CartOwner): Promise<CartRecord> {
    const existing = await this.find(db, marketId, owner);
    if (existing) return existing;

    await sql`
      INSERT INTO carts (market_id, user_id, guest_session_id)
      VALUES (
        ${marketId},
        ${owner.kind === 'user' ? owner.userId : null}::uuid,
        ${owner.kind === 'guest' ? owner.guestSessionId : null}::uuid
      )
      ON CONFLICT DO NOTHING
    `.execute(db);

    const created = await this.find(db, marketId, owner);
    if (!created) throw new Error('cart could not be created');
    return created;
  }

  /**
   * What is in the basket now, oldest first.
   *
   * Locked when `lock` is set, so that adding and removing cannot race with a
   * read that is about to make a decision on what it sees.
   */
  async liveItems(db: DbExecutor, cartId: string, lock = false): Promise<CartItemRecord[]> {
    let query = db
      .selectFrom('cart_items')
      .select(['id', 'reservation_id', 'draw_id', 'created_at'])
      .where('cart_id', '=', cartId)
      .where('removed_at', 'is', null)
      .orderBy('created_at');
    if (lock) query = query.forUpdate();
    const rows = await query.execute();
    return rows.map((r) => ({
      id: r.id,
      reservationId: r.reservation_id,
      drawId: r.draw_id,
      createdAt: r.created_at,
    }));
  }

  /** One live item of this basket, by its id. */
  async findLiveItem(
    db: DbExecutor,
    cartId: string,
    itemId: string,
    lock = false,
  ): Promise<CartItemRecord | null> {
    let query = db
      .selectFrom('cart_items')
      .select(['id', 'reservation_id', 'draw_id', 'created_at'])
      .where('cart_id', '=', cartId)
      .where('id', '=', itemId)
      .where('removed_at', 'is', null);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      reservationId: row.reservation_id,
      drawId: row.draw_id,
      createdAt: row.created_at,
    };
  }

  /** Whether this basket already holds a live item for the draw. */
  async liveItemForDraw(
    db: DbExecutor,
    cartId: string,
    drawId: string,
  ): Promise<CartItemRecord | null> {
    const row = await db
      .selectFrom('cart_items')
      .select(['id', 'reservation_id', 'draw_id', 'created_at'])
      .where('cart_id', '=', cartId)
      .where('draw_id', '=', drawId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      reservationId: row.reservation_id,
      drawId: row.draw_id,
      createdAt: row.created_at,
    };
  }

  /**
   * Puts a reservation in the basket.
   *
   * The market comes from the basket, not from the caller, so an item cannot
   * be filed under a market its basket does not belong to. The composite
   * foreign keys then check it against the draw as well.
   */
  async addItem(
    db: DbExecutor,
    item: { cartId: string; marketId: string; drawId: string; reservationId: string },
  ): Promise<string> {
    const row = await db
      .insertInto('cart_items')
      .values({
        cart_id: item.cartId,
        market_id: item.marketId,
        draw_id: item.drawId,
        reservation_id: item.reservationId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Takes an item out of the basket. Conditional, so removing twice is harmless. */
  async removeItem(db: DbExecutor, cartId: string, itemId: string): Promise<boolean> {
    const result = await db
      .updateTable('cart_items')
      .set({ removed_at: sql<Date>`now()` })
      .where('id', '=', itemId)
      .where('cart_id', '=', cartId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  private ownerQuery(db: DbExecutor, marketId: string, owner: CartOwner) {
    const query = db
      .selectFrom('carts')
      .select(['id', 'market_id', 'user_id', 'guest_session_id'])
      .where('market_id', '=', marketId);
    return owner.kind === 'user'
      ? query.where('user_id', '=', owner.userId)
      : query.where('guest_session_id', '=', owner.guestSessionId);
  }
}

function toCart(row: {
  id: string;
  market_id: string;
  user_id: string | null;
  guest_session_id: string | null;
}): CartRecord {
  return {
    id: row.id,
    marketId: row.market_id,
    owner: row.user_id
      ? { kind: 'user', userId: row.user_id }
      : { kind: 'guest', guestSessionId: row.guest_session_id! },
  };
}
