import { Global, Module } from '@nestjs/common';
import { GuestSessionsRepository } from './guest-sessions.repository';
import { GuestSessionsService } from './guest-sessions.service';

/**
 * Guest identity for checkout (ADR-0029).
 *
 * Global because the access guard resolves a guest on every public route that
 * asks to identify its caller, the same way SessionsService is available to
 * it. The module exposes no controller: P5-3 is the identity itself, and the
 * routes that use it arrive with guest verification in P5-4.
 */
@Global()
@Module({
  providers: [GuestSessionsRepository, GuestSessionsService],
  exports: [GuestSessionsRepository, GuestSessionsService],
})
export class GuestsModule {}
