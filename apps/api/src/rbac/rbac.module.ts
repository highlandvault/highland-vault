import { Module } from '@nestjs/common';
import { RbacRepository } from './rbac.repository';
import { RbacService } from './rbac.service';

@Module({
  providers: [RbacRepository, RbacService],
  exports: [RbacService],
})
export class RbacModule {}
