import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MarketsModule } from '../markets/markets.module';
import { AdminTermsController } from './admin-terms.controller';
import { AdminTermsService } from './admin-terms.service';
import { TermsController } from './terms.controller';
import { TermsRepository } from './terms.repository';
import { TermsService } from './terms.service';

/**
 * Market terms (P5-6; B12, ADR-0031).
 *
 * Exports `TermsService` because P5-7 needs to ask two questions at order
 * creation: is there an active version in this market, and has this customer
 * accepted it.
 */
@Module({
  imports: [AuditModule, MarketsModule],
  controllers: [TermsController, AdminTermsController],
  providers: [TermsRepository, TermsService, AdminTermsService],
  exports: [TermsRepository, TermsService],
})
export class TermsModule {}
