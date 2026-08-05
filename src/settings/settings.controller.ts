import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import {
  CreateReceivingAccountDto,
  ReorderReceivingAccountsDto,
  UpdateReceivingAccountDto,
} from './dto/receiving-account.dto';

/**
 * Owner-configured business policy.
 *
 * `GET` is open to any signed-in user because an employee needs the return
 * window and the active account names to do a sale — but the *response* is
 * narrowed by permission inside the service, so a staff read never contains the
 * Owner's WhatsApp preferences or inactive accounts. Every write requires
 * `settings.manage`, which only the Owner holds.
 */
@ApiTags('settings')
@ApiBearerAuth()
@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Business settings, narrowed to what the caller may see' })
  read() {
    return this.settings.read();
  }

  @Put()
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Update business policy (return window, WhatsApp summaries, security maximum)' })
  update(@Body() dto: UpdateSettingsDto) {
    return this.settings.update(dto);
  }

  @Post('receiving-accounts')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Add an account customers can send money to' })
  createAccount(@Body() dto: CreateReceivingAccountDto) {
    return this.settings.createAccount(dto);
  }

  /**
   * There is deliberately no DELETE. Money movement will reference these rows,
   * and a financial record pointing at a deleted account cannot be explained
   * later. Deactivate with `isActive: false` instead.
   */
  @Patch('receiving-accounts/:id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Rename, re-provider, deactivate or restore an account' })
  updateAccount(@Param('id') id: string, @Body() dto: UpdateReceivingAccountDto) {
    return this.settings.updateAccount(id, dto);
  }

  @Put('receiving-accounts/order')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Set the order accounts appear in at the till' })
  reorderAccounts(@Body() dto: ReorderReceivingAccountsDto) {
    return this.settings.reorderAccounts(dto);
  }
}
