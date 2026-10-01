import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DrawsModule } from '../draws/draws.module';
import { MarketsModule } from '../markets/markets.module';
import { InventoryController } from './inventory.controller';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { TicketAllocator } from './ticket-allocator';
import { UsersRepository } from '../users/users.repository';
import { CapBridgingRepository } from './cap-bridging.repository';
import { TicketsRepository } from './tickets.repository';

@Module({
  imports: [AuthModule, DrawsModule, MarketsModule],
  controllers: [ReservationsController, InventoryController],
  providers: [
    TicketsRepository,
    CapBridgingRepository,
    TicketAllocator,
    ReservationsService,
    // The allocator resolves a guest’s address to an account (ADR-0021).
    UsersRepository,
  ],
  // The basket allocates through the same engine (P5-5): one allocation path,
  // one set of caps and locks, rather than a second copy beside it.
  exports: [TicketsRepository, CapBridgingRepository, TicketAllocator, ReservationsService],
})
export class TicketsModule {}
