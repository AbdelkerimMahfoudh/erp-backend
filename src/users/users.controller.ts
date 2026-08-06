import { Body, Controller, Delete, Get, Param, Patch, Put } from '@nestjs/common';
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

  /*
   * Branch-scoped price-edit delegation.
   *
   * The authority is named in the PATH, not in a body. There is deliberately no
   * generic "grant permission X" endpoint: a client cannot ask for
   * `discount.override`, `user.manage` or anything else, because there is no
   * field to ask in. Adding a second delegatable permission later means adding a
   * second explicit route, which is exactly the friction that keeps this narrow.
   *
   * Both verbs are idempotent, so a retried request — or two Owners tapping at
   * once — settles on the same state instead of erroring or duplicating.
   */

  @Put(':userId/branches/:branchId/delegations/price-edit')
  @RequirePermissions('user.manage')
  @ApiOperation({
    summary: 'Let a Store Manager edit ordinary prices in ONE branch',
    description:
      'Owner-only. The target must hold an active Store Manager assignment in that exact branch. ' +
      'This never authorizes selling below cost, which stays gated on discount.override (Owner-only, never delegatable).',
  })
  grantPriceEdit(@Param('userId') userId: string, @Param('branchId') branchId: string) {
    return this.users.grantPriceEdit(userId, branchId);
  }

  @Delete(':userId/branches/:branchId/delegations/price-edit')
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: 'Withdraw branch price-edit delegation (safe if it was never granted)' })
  revokePriceEdit(@Param('userId') userId: string, @Param('branchId') branchId: string) {
    return this.users.revokePriceEdit(userId, branchId);
  }
}
