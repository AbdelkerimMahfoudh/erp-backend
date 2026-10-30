import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserManagementService } from './user-management.service';
import { UsersController } from './users.controller';
import { RoleChangeService } from './role-change.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UserManagementService, RoleChangeService],
  exports: [UsersService],
})
export class UsersModule {}
