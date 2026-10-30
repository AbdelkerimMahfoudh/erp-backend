import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ActingOwnerService } from './acting-owner.service';
import { AppointActingOwnerDto, RequestActingOwnerCodeDto, RevokeActingOwnerDto } from './dto/acting-owner.dto';

/*
 * The account's sensitive-route limit, read the way `account.controller.ts` reads it: a decorator is evaluated before
 * anything is injected, the Joi schema validates the variable, and the fallback is the schema's own default. On top of
 * the code service's own per-person and per-number caps.
 */
const SENSITIVE_THROTTLE = { default: { limit: Number(process.env.ACCOUNT_THROTTLE_LIMIT) || 5, ttl: 60_000 } };

/**
 * The temporary Acting Owner (D225). No `@RequirePermissions`: the service checks the Owner ROLE itself, because an
 * Acting Owner holds the Owner's permissions and must still not appoint, extend or remove an Acting Owner. Reading is
 * open to every signed-in member: the Owner sees all appointments, anyone else only their own.
 *
 * Appointing and removing take a step-up: the Owner's password, then the WhatsApp code sent for that very change
 * (`POST acting-owner/code`). Changing an appointment is removing it and appointing again, each confirmed so.
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

  @Post('code')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  @ApiOperation({ summary: 'Owner only: password again, then a confirmation code to the verified WhatsApp number for this one change' })
  requestCode(@Body() dto: RequestActingOwnerCodeDto) {
    return this.acting.requestCode(dto);
  }

  @Post()
  @Throttle(SENSITIVE_THROTTLE)
  @ApiOperation({ summary: 'Appoint an Acting Owner (Owner only, password and WhatsApp code); one at a time' })
  appoint(@Body() dto: AppointActingOwnerDto) {
    return this.acting.appoint(dto);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  @ApiOperation({ summary: 'Remove an Acting Owner now (Owner only, password and WhatsApp code)' })
  revoke(@Param('id') id: string, @Body() dto: RevokeActingOwnerDto) {
    return this.acting.revoke(id, dto);
  }
}
