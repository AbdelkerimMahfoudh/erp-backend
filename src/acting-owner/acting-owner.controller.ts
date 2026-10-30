import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActingOwnerService } from './acting-owner.service';
import { AppointActingOwnerDto, RevokeActingOwnerDto } from './dto/acting-owner.dto';

/**
 * The temporary Acting Owner (D225). No `@RequirePermissions`: the service checks the Owner ROLE itself, because an
 * Acting Owner holds the Owner's permissions and must still not appoint, extend or remove an Acting Owner. Reading is
 * open to every signed-in member: the Owner sees all appointments, anyone else only their own.
 */
@ApiTags('acting-owner')
@ApiBearerAuth()
@Controller({ path: 'acting-owner', version: '1' })
export class ActingOwnerController {
  constructor(private readonly acting: ActingOwnerService) {}

  @Get()
  @ApiOperation({ summary: 'Acting Owner appointments: every one for the Owner, your own for anyone else' })
  list() {
    return this.acting.list();
  }

  @Post()
  @ApiOperation({ summary: 'Appoint an Acting Owner (Owner only, password confirmed); one at a time' })
  appoint(@Body() dto: AppointActingOwnerDto) {
    return this.acting.appoint(dto);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove an Acting Owner now (Owner only, password confirmed)' })
  revoke(@Param('id') id: string, @Body() dto: RevokeActingOwnerDto) {
    return this.acting.revoke(id, dto);
  }
}
