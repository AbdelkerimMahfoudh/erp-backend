import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserManagementService } from './user-management.service';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UserManagementService],
  exports: [UsersService],
})
export class UsersModule {}
