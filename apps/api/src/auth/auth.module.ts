import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
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
  ],
  exports: [SessionsService],
})
export class AuthModule {}
