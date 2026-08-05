import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { UserManagementService } from './user-management.service';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * Owner-only team management (F1 Stage 1). Every route requires `user.manage`,
 * which only the Owner role holds — a Manager or Employee is rejected with 403
 * by {@link RequirePermissions}. The tenant-scoped client keeps every query
 * inside the caller's company.
 *
 * There is no create and no delete: users arrive by invitation (a later stage)
 * and are deactivated, never hard-deleted, so their audit trail stays
 * attributable.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UserManagementService) {}

  @Get()
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: 'List company users with their branches, roles and contact state' })
  list() {
    return this.users.list();
  }

  @Get(':id')
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: 'One user, with branch assignments and contact state' })
  getOne(@Param('id') id: string) {
    return this.users.getOne(id);
  }

  @Patch(':id')
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: 'Edit name, contact (phone/email) or active flag. No role or password here.' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }
}
