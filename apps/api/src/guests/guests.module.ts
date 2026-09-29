import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketsModule } from '../markets/markets.module';
import { EmailVerificationController } from './email-verification.controller';
import { EmailVerificationRepository } from './email-verification.repository';
import { EmailVerificationService } from './email-verification.service';
import { GuestSessionsRepository } from './guest-sessions.repository';
import { GuestSessionsService } from './guest-sessions.service';

/**
 * Guest identity for checkout (ADR-0029).
 *
 * Global because the access guard resolves a guest on every public route that
 * asks to identify its caller, the same way SessionsService is available to
 * it. Its only controller is the email verification one (P5-4), which is also
 * the only place a guest cookie is set: a guest session is created when a code
 * is first requested, because there is nothing to verify without one.
 */
@Global()
@Module({
  // AuthModule for the shared fail-closed RateLimiter (guest code sending is
  // limited by the same limiter that protects login, not a second one) and
  // MarketsModule for MarketGuard, as the ticket routes do.
  imports: [AuthModule, MarketsModule],
  controllers: [EmailVerificationController],
  providers: [
    GuestSessionsRepository,
    GuestSessionsService,
    EmailVerificationRepository,
    EmailVerificationService,
  ],
  exports: [GuestSessionsRepository, GuestSessionsService, EmailVerificationService],
})
export class GuestsModule {}
