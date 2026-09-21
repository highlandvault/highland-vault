# Legacy System Inventory (migration discovery)

- **Status:** not started. Blocked on access to the legacy system (OPEN O17).
- **Governing decision:** ADR-0018. Discovery begins early; the migration must be deterministic and reproducible.

## What is needed from the owner

1. **Plugin list.** The active WordPress plugins with versions, especially the competition/lottery, wallet, instant-win, referral and payment-gateway plugins.
2. **Database export.** A **sanitized** export of the WordPress MySQL database (schema + data), with personal data masked if it leaves production.
3. **Uploads (optional).** Media and upload directory structure, if prize images are to be migrated.
4. **Open draws.** Which draws will still be open at cutover and must carry across.
5. **Payment records.** The payment gateway(s) used historically and whether provider references are stored in WooCommerce order meta.

## Inventory checklist

| Area                                   | Source tables / plugin | Record count | Notes / mapping status                           |
| -------------------------------------- | ---------------------- | ------------ | ------------------------------------------------ |
| WordPress core (users, usermeta)       |                        |              | Password hash format (phpass / bcrypt)           |
| WooCommerce orders                     |                        |              | HPOS or posts-based storage?                     |
| Competition plugin (draws, tickets)    |                        |              | Ticket number format, per-person caps            |
| Instant-win functionality              |                        |              | How winning numbers are stored                   |
| Winners                                |                        |              | Main-draw vs instant-win separation              |
| Wallet plugin (balances, transactions) |                        |              | Is there a transaction history or only balances? |
| Referrals                              |                        |              |                                                  |
| Fulfilment                             |                        |              |                                                  |
| Payment records                        |                        |              | Provider references                              |
| Open draws at cutover                  |                        |              |                                                  |

## Mapping and reconciliation

To be produced after the inventory: source → target mapping per entity, and reconciliation queries (counts and sums per market and currency).
