# Architecture Decision Records

Short, traceable records of accepted decisions. Source: `docs/PROJECT_INITIALIZATION_REPORT.md` Revision 2 (D1–D19) and the owner approval of O1–O6 and O18.

An accepted ADR is changed only by a new ADR that supersedes it.

| ADR                                              | Title                                                      | Source |
| ------------------------------------------------ | ---------------------------------------------------------- | ------ |
| [0001](0001-local-development-infrastructure.md) | Local development infrastructure                           | D1     |
| [0002](0002-database-access-and-migrations.md)   | Database access and plain-SQL migrations                   | D2     |
| [0003](0003-users-and-markets.md)                | Users and markets                                          | D3     |
| [0004](0004-draws-belong-to-one-market.md)       | Each draw belongs to exactly one market (V1)               | D4     |
| [0005](0005-market-routing-and-germany-gate.md)  | Market routing and the Germany gate                        | D5     |
| [0006](0006-payment-provider-abstraction.md)     | Provider-independent payments                              | D6     |
| [0007](0007-wallet.md)                           | Wallet                                                     | D7     |
| [0008](0008-guests-and-ticket-caps.md)           | Guests and ticket caps                                     | D8     |
| [0009](0009-admin-inside-web-app.md)             | Admin inside the main Next.js application                  | D9     |
| [0010](0010-roles-rbac-mfa.md)                   | Roles, permission-based RBAC and MFA                       | D10    |
| [0011](0011-ticket-engine.md)                    | Ticket engine                                              | D11    |
| [0012](0012-instant-wins.md)                     | Instant wins                                               | D12    |
| [0013](0013-postal-entries.md)                   | Postal entries                                             | D13    |
| [0014](0014-settlement.md)                       | Settlement                                                 | D14    |
| [0015](0015-reports.md)                          | Initial reports                                            | D15    |
| [0016](0016-compliance.md)                       | Compliance configuration                                   | D16    |
| [0017](0017-referrals-and-vault-meter.md)        | Referrals and Vault Meter as configurable infrastructure   | D17    |
| [0018](0018-legacy-migration.md)                 | Legacy data migration                                      | D18    |
| [0019](0019-phases-not-calendar-days.md)         | Days are phases, gated by the Definition of Done           | D19    |
| [0020](0020-guest-email-verification.md)         | Guest email verification                                   | O1     |
| [0021](0021-guest-account-cap-bridging.md)       | Guest → account ticket-cap bridging                        | O2     |
| [0022](0022-wallet-credit-win-without-wallet.md) | Wallet-credit instant win for a recipient without a wallet | O3     |
| [0023](0023-eur-wallet-across-ie-and-de.md)      | One EUR wallet shared by Ireland and Germany               | O4     |
| [0024](0024-settlement-grace-period.md)          | Settlement grace period after close                        | O5     |
| [0025](0025-settlement-edge-cases.md)            | Settlement with too few eligible tickets                   | O6     |
| [0026](0026-one-basket-per-market.md)            | One basket and order per market                            | O18    |
