import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { NamesService } from './names.service';
import { UpdateNamesDto } from './dto/update-names.dto';

/** The business's and its stores' Latin and Arabic names (D225). Owner only. */
@ApiTags('names')
@ApiBearerAuth()
@Controller({ version: '1' })
export class NamesController {
  constructor(private readonly names: NamesService) {}

  @Get('business/names')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'The business and its stores, with both names and which Arabic names are still missing' })
  overview() {
    return this.names.overview();
  }

  @Patch('business/names')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: "Edit the business's Latin or Arabic name; the other is untouched" })
  renameBusiness(@Body() dto: UpdateNamesDto) {
    return this.names.renameBusiness(dto);
  }

  @Patch('branches/:id/names')
  @RequirePermissions('branch.manage')
  @ApiOperation({ summary: "Edit a store's Latin or Arabic name; the other is untouched" })
  renameStore(@Param('id') id: string, @Body() dto: UpdateNamesDto) {
    return this.names.renameStore(id, dto);
  }
}
