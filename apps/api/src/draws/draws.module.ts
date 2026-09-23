import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MarketsModule } from '../markets/markets.module';
import { AdminDrawsController } from './admin-draws.controller';
import { AdminDrawsService } from './admin-draws.service';
import { DrawsController } from './draws.controller';
import { DrawsRepository } from './draws.repository';
import { DrawsService } from './draws.service';

@Module({
  imports: [AuditModule, MarketsModule],
  controllers: [DrawsController, AdminDrawsController],
  providers: [DrawsRepository, DrawsService, AdminDrawsService],
  exports: [DrawsRepository],
})
export class DrawsModule {}
