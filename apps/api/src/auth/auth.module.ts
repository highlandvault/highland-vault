import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { CapBridgingRepository } from '../tickets/cap-bridging.repository';
import { UsersRepository } from '../users/users.repository';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { RateLimiter } from './rate-limiter';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AuditModule, RbacModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    MfaService,
    RateLimiter,
    SessionsRepository,
    SessionsService,
    UsersRepository,
    // Provided here rather than imported from TicketsModule, which imports
    // this one. It is a stateless repository with no dependencies of its own,
    // and registration needs it to bridge a guest's cap (ADR-0021).
    CapBridgingRepository,
  ],
  exports: [SessionsService, RateLimiter],
})
export class AuthModule {}
