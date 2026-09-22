import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminMarketsController } from './admin-markets.controller';
import { AdminMarketsService } from './admin-markets.service';
import { MarketGuard } from './market.guard';
import { MarketsController } from './markets.controller';
import { MarketsRepository } from './markets.repository';
import { MarketsService } from './markets.service';

@Module({
  imports: [AuditModule],
  controllers: [MarketsController, AdminMarketsController],
  providers: [MarketsRepository, MarketsService, AdminMarketsService, MarketGuard],
  exports: [MarketsRepository, MarketsService, MarketGuard],
})
export class MarketsModule {}
