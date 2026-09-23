import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DrawsModule } from '../draws/draws.module';
import { MarketsModule } from '../markets/markets.module';
import { InventoryController } from './inventory.controller';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { TicketAllocator } from './ticket-allocator';
import { TicketsRepository } from './tickets.repository';

@Module({
  imports: [AuthModule, DrawsModule, MarketsModule],
  controllers: [ReservationsController, InventoryController],
  providers: [TicketsRepository, TicketAllocator, ReservationsService],
})
export class TicketsModule {}
