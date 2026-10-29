import { Body, Controller, HttpCode, HttpStatus, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { IsArabicName, IsLatinName, NormalizeName } from '../common/bilingual-name';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard, type AdminRequest } from './platform-admin.guard';
import { PlatformNamesService } from './platform-names.service';

/** Either name or both (D225), why, and the administrator's password. */
class PlatformNamesDto {
  @IsOptional() @NormalizeName() @IsLatinName() name?: string;
  @IsOptional() @NormalizeName() @IsArabicName() nameAr?: string;
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

/**
 * The console's name edits (D225): a business, one of its stores, one of its people. Platform routes only, behind the
 * administrator guard and a password confirmation, each audited.
 */
@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class PlatformNamesController {
  constructor(
    private readonly admins: PlatformAdminService,
    private readonly names: PlatformNamesService,
  ) {}

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Patch('businesses/:id/names')
  @HttpCode(HttpStatus.OK)
  async business(@Param('id') id: string, @Body() dto: PlatformNamesDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.names.renameBusiness(id, dto, { admin: req.platformAdmin!, ip: req.ip, reason: dto.reason });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Patch('businesses/:id/stores/:storeId/names')
  @HttpCode(HttpStatus.OK)
  async store(@Param('id') id: string, @Param('storeId') storeId: string, @Body() dto: PlatformNamesDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.names.renameStore(id, storeId, dto, { admin: req.platformAdmin!, ip: req.ip, reason: dto.reason });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Patch('businesses/:id/accounts/:userId/names')
  @HttpCode(HttpStatus.OK)
  async person(@Param('id') id: string, @Param('userId') userId: string, @Body() dto: PlatformNamesDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.names.renamePerson(id, userId, dto, { admin: req.platformAdmin!, ip: req.ip, reason: dto.reason });
  }
}
